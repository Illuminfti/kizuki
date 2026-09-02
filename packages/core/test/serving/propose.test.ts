import { afterEach, describe, expect, test } from "bun:test";
import { listAudit } from "../../src/agents";
import { servePropose } from "../../src/serving/propose";
import type { ProposeArgs } from "../../src/serving/propose";
import { ServeError } from "../../src/serving/types";
import { listProposals, setProposalStatus } from "../../src/staging/proposals";
import { serializePage } from "../../src/vault/frontmatter";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture | null = null;

function newFixture(): Fixture {
  fixture = serveFixture();
  return fixture;
}

afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

function refusal(run: () => unknown): ServeError {
  try {
    run();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected a ServeError");
}

function candidate(live: Fixture, body: string): ProposeArgs {
  return {
    kind: "claim",
    target: "facts:candidate",
    body,
    frontmatter: { type: "fact", title: "A candidate kettle claim" },
    subjects: ["person:ada"],
    provenance: [live.events["public"] as string],
    confidence: 0.7,
  };
}

describe("servePropose files a claim for the receipted writer", () => {
  test("a stored proposal carries the agent identity and stays pending", () => {
    const live = newFixture();
    const envelope = servePropose(
      live.agent("reader-private"),
      candidate(live, "The kettle boiled at dawn."),
    );
    expect(envelope.data?.outcome).toBe("stored");
    expect(envelope.canon).toEqual([]);
    expect(envelope.quoted).toEqual([]);

    const staged = listProposals(live.db, { status: "pending", kind: "claim" });
    expect(staged).toHaveLength(1);
    expect(staged[0]?.producer).toBe("agent:reader-private");
    expect(staged[0]?.subjects).toEqual(["person:ada"]);
    expect(staged[0]?.confidence).toBe(0.7);

    const row = listAudit(live.db, "reader-private", { limit: 1 })[0];
    expect(row?.query_shape["proposal_ids"]).toEqual([
      staged[0]?.proposal_id as string,
    ]);
    const body = row?.query_shape["body"] as { sha256?: string };
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row?.query_shape)).not.toContain("boiled at dawn");
  });

  test("refiling the same candidate is a duplicate, not an error", () => {
    const live = newFixture();
    const ctx = live.agent("reader-private");
    const args = candidate(live, "The kettle boiled at dawn.");
    const first = servePropose(ctx, args);
    const second = servePropose(ctx, args);
    expect(second.data?.outcome).toBe("duplicate");
    expect(
      second.data?.outcome === "duplicate" ? second.data.proposal_id : "",
    ).toBe(first.data?.outcome === "stored" ? first.data.proposal_id : "");
  });

  test("a refile is never poisoned by an earlier terminal status", () => {
    const live = newFixture();
    const ctx = live.agent("reader-private");
    const args = candidate(live, "The kettle boiled at dawn.");
    const stored = servePropose(ctx, args).data;
    const proposalId = stored?.outcome === "stored" ? stored.proposal_id : "";
    setProposalStatus(live.db, proposalId, "rejected", "not useful");
    expect(servePropose(ctx, args).data).toEqual({
      outcome: "duplicate",
      proposal_id: proposalId,
    });
  });

  test("the owner cannot propose and purge reviews cannot be filed", () => {
    const live = newFixture();
    expect(
      refusal(() =>
        servePropose(live.owner(), candidate(live, "An owner candidate.")),
      ).code,
    ).toBe("tool_not_granted");
    expect(
      refusal(() =>
        servePropose(live.agent("reader-private"), {
          ...candidate(live, "A purge review."),
          kind: "purge_review" as ProposeArgs["kind"],
        }),
      ).code,
    ).toBe("invalid_arguments");
  });

  test("frontmatter that promotion owns is refused up front", () => {
    const live = newFixture();
    expect(
      refusal(() =>
        servePropose(live.agent("reader-private"), {
          ...candidate(live, "A reserved candidate."),
          frontmatter: { type: "fact", sensitivity: "public" },
        }),
      ).code,
    ).toBe("invalid_arguments");
  });

  test("a frontmatter array the vault cannot write is refused", () => {
    const live = newFixture();
    const ctx = live.agent("reader-private");
    const mixed = {
      ...candidate(live, "A candidate with a mixed array."),
      frontmatter: {
        type: "fact",
        "x-tags": [1, true] as unknown as string[],
      },
    };
    expect(refusal(() => servePropose(ctx, mixed)).code).toBe(
      "invalid_arguments",
    );
    expect(
      listProposals(live.db, { status: "pending", kind: "claim" }),
    ).toHaveLength(0);

    const strings = {
      ...candidate(live, "A candidate with a string array."),
      frontmatter: { type: "fact", "x-tags": ["kettle", "log"] },
    };
    expect(servePropose(ctx, strings).data?.outcome).toBe("stored");
    // The writer would have refused the mixed array, which is the point of
    // refusing it here: a stored proposal has to be serializable.
    expect(() =>
      serializePage({
        data: { "x-tags": ["kettle", "log"] },
        body: "",
      }),
    ).not.toThrow();
    expect(() =>
      serializePage({ data: { "x-tags": [1, true] }, body: "" }),
    ).toThrow(TypeError);
  });

  test("provenance must name live events this principal can read", () => {
    const live = newFixture();
    expect(
      refusal(() =>
        servePropose(live.agent("reader-private"), {
          ...candidate(live, "A candidate with no source."),
          provenance: ["01J0000000000000000000MISS"],
        }),
      ).code,
    ).toBe("invalid_arguments");

    expect(
      refusal(() =>
        servePropose(live.agent("reader-personal"), {
          ...candidate(live, "A candidate citing a private record."),
          provenance: [live.events["private"] as string],
        }),
      ).code,
    ).toBe("above_ceiling");

    expect(
      refusal(() =>
        servePropose(live.agent("reader-private"), {
          ...candidate(live, "A candidate citing a retracted record."),
          provenance: [live.events["tombstoned"] as string],
        }),
      ).code,
    ).toBe("invalid_arguments");
  });

  test("a scoped grant pins both the subjects and the page type", () => {
    const live = newFixture();
    expect(
      refusal(() =>
        servePropose(live.agent("subjected"), {
          ...candidate(live, "A candidate about someone else."),
          subjects: ["person:grace"],
        }),
      ).code,
    ).toBe("subject_out_of_scope");

    expect(
      refusal(() =>
        servePropose(live.agent("typed"), {
          ...candidate(live, "A candidate of the wrong type."),
          frontmatter: { type: "fact", title: "Wrong type" },
        }),
      ).code,
    ).toBe("type_out_of_scope");
  });
});
