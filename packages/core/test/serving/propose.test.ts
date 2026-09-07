import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { listAudit } from "../../src/agents";
import {
  getClaim,
  listClaims,
  pendingRetrievalOps,
} from "../../src/claims/store";
import { retrievalDocId } from "../../src/retrieval/ids";
import { serveHealth } from "../../src/serving/health";
import { servePropose } from "../../src/serving/propose";
import type { ProposeArgs } from "../../src/serving/propose";
import { ServeError } from "../../src/serving/types";
import { serializePage } from "../../src/vault/frontmatter";
import { ReferenceRetrievalPort } from "../contracts/reference-retrieval";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture | null = null;

async function newFixture(): Promise<Fixture> {
  fixture = await serveFixture();
  return fixture;
}

afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

async function refusal(run: () => Promise<unknown>): Promise<ServeError> {
  try {
    await run();
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

function agentClaims(live: Fixture): ReturnType<typeof listClaims> {
  return listClaims(live.db, {}).filter((claim) =>
    claim.producer.startsWith("agent:"),
  );
}

describe("servePropose files a claim for the receipted writer", () => {
  test("a stored claim is live, stamped with the agent, and needs nobody", async () => {
    const live = await newFixture();
    const envelope = await servePropose(
      live.agent("reader-private"),
      candidate(live, "The kettle boiled at dawn."),
    );
    expect(envelope.data?.outcome).toBe("stored");
    expect(envelope.canon).toEqual([]);
    expect(envelope.quoted).toEqual([]);

    const filed = agentClaims(live);
    expect(filed).toHaveLength(1);
    const claim = filed[0];
    expect(claim?.claim_id).toBe(envelope.data?.claim_id ?? "");
    expect(claim?.producer).toBe("agent:reader-private");
    expect(claim?.subjects).toEqual(["person:ada"]);
    // Live the moment it is filed: no queue, no owner step, no `pending`.
    expect(claim?.status).toBe("live");
    // One untrusted source caps what a single relayed claim may assert.
    expect(claim?.authority).toBe("model_inference");
    expect(claim?.confidence).toBe(0.5);
    expect(claim?.taint).toBe("quoted");
    expect(claim?.frontmatter["x-relayed-by"]).toBe("agent:reader-private");

    const row = listAudit(live.db, "reader-private", { limit: 1 })[0];
    const claimId = claim?.claim_id as string;
    expect(row?.query_shape["claim_ids"]).toEqual([
      {
        len: claimId.length,
        sha256: new Bun.CryptoHasher("sha256").update(claimId).digest("hex"),
      },
    ]);
    const body = row?.query_shape["body"] as { sha256?: string };
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row?.query_shape)).not.toContain("boiled at dawn");
  });

  test("a bound retrieval port is the one the claim store indexes into", async () => {
    const live = await newFixture();
    const port = new ReferenceRetrievalPort({
      vault_path: live.vaultPath,
      data_dir: join(live.vaultPath, ".kizuki", "retrieval", "test"),
      config: {},
      secrets: () => Promise.reject(new Error("no secret is needed here")),
      clock: () => "2026-03-01T00:00:00Z",
      logger: () => undefined,
    });
    const ctx = { ...live.agent("reader-private"), retrieval: port };

    const filed = await servePropose(ctx, candidate(live, "The kettle is indexed."));
    const claimId = filed.data?.claim_id ?? "";
    // The port the host bound is the one the claim reaches: serving holds it
    // for the process, it does not open its own.
    expect((await port.verifyAbsent([retrievalDocId("claim", claimId)])).found).toEqual([
      retrievalDocId("claim", claimId),
    ]);
  });

  test("a refresh that fails degrades the write, it does not fail it", async () => {
    const live = await newFixture();
    const port = new ReferenceRetrievalPort({
      vault_path: live.vaultPath,
      data_dir: join(live.vaultPath, ".kizuki", "retrieval", "flaky"),
      config: {},
      secrets: () => Promise.reject(new Error("no secret is needed here")),
      clock: () => "2026-03-01T00:00:00Z",
      logger: () => undefined,
    });
    const upsert = port.upsert.bind(port);
    let refuse = true;
    port.upsert = async (docs) => {
      if (refuse) throw new Error("the index is down");
      return upsert(docs);
    };
    const ctx = { ...live.agent("reader-private"), retrieval: port };

    const filed = await servePropose(ctx, candidate(live, "The kettle is indexed."));
    const claimId = filed.data?.claim_id ?? "";
    // The claim is durable and the call succeeded; only the index is behind.
    expect(filed.data?.outcome).toBe("stored");
    expect(getClaim(live.db, claimId)?.status).toBe("live");
    expect((await port.verifyAbsent([claimId])).found).toEqual([]);
    expect(pendingRetrievalOps(live.db).map((op) => op.doc_id)).toEqual([
      claimId,
    ]);
    expect(serveHealth(live.owner()).data?.pending_retrieval_ops).toBe(1);

    // The next pass drains it, and the refile that deduped is what triggers
    // the sweep: a duplicate must not leave the index stale forever.
    refuse = false;
    const refiled = await servePropose(
      ctx,
      candidate(live, "The kettle is indexed."),
    );
    expect(refiled.data?.outcome).toBe("duplicate");
    expect((await port.verifyAbsent([retrievalDocId("claim", claimId)])).found).toEqual([
      retrievalDocId("claim", claimId),
    ]);
    expect(pendingRetrievalOps(live.db)).toEqual([]);
  });

  test("refiling the same candidate is a duplicate, not an error", async () => {
    const live = await newFixture();
    const ctx = live.agent("reader-private");
    const args = candidate(live, "The kettle boiled at dawn.");
    const first = await servePropose(ctx, args);
    const second = await servePropose(ctx, args);
    expect(second.data?.outcome).toBe("duplicate");
    expect(second.data?.claim_id).toBe(first.data?.claim_id ?? "");
    expect(agentClaims(live)).toHaveLength(1);
  });

  test("the same body under another target is a second claim", async () => {
    const live = await newFixture();
    const ctx = live.agent("reader-private");
    const body = "The kettle boiled at dawn.";
    const first = await servePropose(ctx, candidate(live, body));
    const second = await servePropose(ctx, {
      ...candidate(live, body),
      target: "facts:other-candidate",
    });
    expect(second.data?.outcome).toBe("stored");
    expect(second.data?.claim_id).not.toBe(first.data?.claim_id ?? "");
    expect(agentClaims(live)).toHaveLength(2);
  });

  test("a subject and a registered predicate key the claim", async () => {
    const live = await newFixture();
    const ctx = live.agent("reader-private");
    const filed = await servePropose(ctx, {
      ...candidate(live, "Ada works at Acme."),
      subject: "person:ada",
      predicate: "employment.works_at",
      object: "Acme",
    });
    const claim = getClaim(live.db, filed.data?.claim_id ?? "");
    expect(claim?.claim_key).toMatch(/^[0-9a-f]{64}$/);
    expect(claim?.predicate).toBe("employment.works_at");
    expect(claim?.object).toBe("Acme");
    expect(claim?.polarity).toBe("positive");
  });

  test("a predicate is refused when it is unknown or cannot be keyed", async () => {
    const live = await newFixture();
    const ctx = live.agent("reader-private");
    expect(
      (
        await refusal(() =>
          servePropose(ctx, {
            ...candidate(live, "Ada does something unregistered."),
            subject: "person:ada",
            predicate: "employment.astrology",
          }),
        )
      ).message,
    ).toBe("invalid arguments: predicate: must be a registered predicate");

    expect(
      (
        await refusal(() =>
          servePropose(ctx, {
            ...candidate(live, "A claim with no subject to key."),
            subjects: [],
            predicate: "employment.works_at",
          }),
        )
      ).message,
    ).toBe("invalid arguments: predicate: needs a subject to key the claim");
  });

  test("the owner cannot propose and purge reviews cannot be filed", async () => {
    const live = await newFixture();
    expect(
      (
        await refusal(() =>
          servePropose(live.owner(), candidate(live, "An owner candidate.")),
        )
      ).code,
    ).toBe("tool_not_granted");
    expect(
      (
        await refusal(() =>
          servePropose(live.agent("reader-private"), {
            ...candidate(live, "A purge review."),
            kind: "purge_review" as ProposeArgs["kind"],
          }),
        )
      ).code,
    ).toBe("invalid_arguments");
  });

  test("frontmatter the writer owns is refused up front", async () => {
    const live = await newFixture();
    const ctx = live.agent("reader-private");
    for (const key of ["sensitivity", "taint", "id", "status", "sources"]) {
      expect(
        (
          await refusal(() =>
            servePropose(ctx, {
              ...candidate(live, `A candidate claiming ${key}.`),
              frontmatter: { type: "fact", [key]: "public" },
            }),
          )
        ).message,
      ).toBe(
        "invalid arguments: frontmatter: a key is set by the writer, not by a producer",
      );
    }
  });

  test("a frontmatter array the vault cannot write is refused", async () => {
    const live = await newFixture();
    const ctx = live.agent("reader-private");
    const mixedBag: unknown = { type: "fact", "x-tags": [1, true] };
    const mixed = {
      ...candidate(live, "A candidate with a mixed array."),
      frontmatter: mixedBag as NonNullable<ProposeArgs["frontmatter"]>,
    };
    expect((await refusal(() => servePropose(ctx, mixed))).code).toBe(
      "invalid_arguments",
    );
    expect(agentClaims(live)).toHaveLength(0);

    const strings = {
      ...candidate(live, "A candidate with a string array."),
      frontmatter: { type: "fact", "x-tags": ["kettle", "log"] },
    };
    expect((await servePropose(ctx, strings)).data?.outcome).toBe("stored");
    // The writer would have refused the mixed array, which is the point of
    // refusing it here: a stored claim has to be serializable.
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

  test("a frontmatter payload is bounded by items and by total size", async () => {
    const live = await newFixture();
    const ctx = live.agent("reader-private");

    const withTags = (tags: string[], body: string): ProposeArgs => ({
      ...candidate(live, body),
      frontmatter: { type: "fact", "x-tags": tags },
    });
    const tag = (index: number): string => `tag-${index}`;
    const atCap = Array.from({ length: 32 }, (_, index) => tag(index));
    expect(
      (await servePropose(ctx, withTags(atCap, "A candidate at the item cap.")))
        .data?.outcome,
    ).toBe("stored");
    expect(
      (
        await refusal(() =>
          servePropose(
            ctx,
            withTags([...atCap, tag(32)], "A candidate past the item cap."),
          ),
        )
      ).message,
    ).toBe(
      "invalid arguments: frontmatter: an array value holds too many entries",
    );

    // Eight maximum-length strings clear every per-value bound and still
    // multiply into a payload no page should carry.
    const wide: Record<string, string> = { type: "fact" };
    for (let index = 0; index < 8; index += 1) {
      wide[`x-note-${index}`] = "k".repeat(4_096);
    }
    expect(
      (
        await refusal(() =>
          servePropose(ctx, {
            ...candidate(live, "A candidate with a wide payload."),
            frontmatter: wide,
          }),
        )
      ).message,
    ).toBe("invalid arguments: frontmatter: is too large");
  });

  test("a frontmatter bag that is not an object is refused", async () => {
    const live = await newFixture();
    const ctx = live.agent("reader-private");
    const before = listClaims(live.db, {}).length;
    const bags: unknown[] = [12, "abc", ["alpha", "beta"], null];
    for (const bag of bags) {
      expect(
        (
          await refusal(() =>
            servePropose(ctx, {
              ...candidate(live, "A candidate with an unusable bag."),
              frontmatter: bag as NonNullable<ProposeArgs["frontmatter"]>,
            }),
          )
        ).code,
      ).toBe("invalid_arguments");
    }
    // The store still reads: a bag that is not an object never reached it,
    // so no row can break every later listing.
    expect(listClaims(live.db, {})).toHaveLength(before);
  });

  test("provenance must name live events this principal can read", async () => {
    const live = await newFixture();
    expect(
      (
        await refusal(() =>
          servePropose(live.agent("reader-private"), {
            ...candidate(live, "A candidate with no source."),
            provenance: ["01J0000000000000000000MISS"],
          }),
        )
      ).code,
    ).toBe("invalid_arguments");

    expect(
      (
        await refusal(() =>
          servePropose(live.agent("reader-personal"), {
            ...candidate(live, "A candidate citing a private record."),
            provenance: [live.events["private"] as string],
          }),
        )
      ).code,
    ).toBe("above_ceiling");

    expect(
      (
        await refusal(() =>
          servePropose(live.agent("reader-private"), {
            ...candidate(live, "A candidate citing a retracted record."),
            provenance: [live.events["tombstoned"] as string],
          }),
        )
      ).code,
    ).toBe("invalid_arguments");
  });

  test("a refusal never echoes what the caller supplied", async () => {
    const live = await newFixture();
    const ctx = live.agent("reader-private");
    const marker = "kettlecode4711";
    const messages = [
      await refusal(() =>
        servePropose(ctx, {
          ...candidate(live, "A candidate naming an unknown record."),
          provenance: [`01J${marker.toUpperCase()}0000000`],
        }),
      ),
      await refusal(() =>
        servePropose(ctx, {
          ...candidate(live, "A candidate with an unusable key."),
          frontmatter: { [`the ${marker} key`]: "x" },
        }),
      ),
      await refusal(() =>
        servePropose(ctx, {
          ...candidate(live, "A candidate with an oversized value."),
          frontmatter: { "x-note": marker.repeat(1_000) },
        }),
      ),
      await refusal(() =>
        servePropose(ctx, {
          ...candidate(live, "A candidate claiming a reserved key."),
          frontmatter: { sensitivity: "public" },
        }),
      ),
    ].map((error) => error.message);

    for (const message of messages) {
      expect(message.startsWith("invalid arguments: ")).toBe(true);
      expect(message.toLowerCase()).not.toContain(marker);
    }
    expect(messages).toEqual([
      "invalid arguments: provenance: must name live events this principal can read",
      "invalid arguments: frontmatter: a key is not usable",
      "invalid arguments: frontmatter: a string value is too long",
      "invalid arguments: frontmatter: a key is set by the writer, not by a producer",
    ]);
  });

  test("a scoped grant pins the subjects, the subject and the page type", async () => {
    const live = await newFixture();
    expect(
      (
        await refusal(() =>
          servePropose(live.agent("subjected"), {
            ...candidate(live, "A candidate about someone else."),
            subjects: ["person:grace"],
          }),
        )
      ).code,
    ).toBe("subject_out_of_scope");

    expect(
      (
        await refusal(() =>
          servePropose(live.agent("subjected"), {
            ...candidate(live, "A candidate keyed to someone else."),
            subject: "person:grace",
          }),
        )
      ).code,
    ).toBe("subject_out_of_scope");

    expect(
      (
        await refusal(() =>
          servePropose(live.agent("typed"), {
            ...candidate(live, "A candidate of the wrong type."),
            frontmatter: { type: "fact", title: "Wrong type" },
          }),
        )
      ).code,
    ).toBe("type_out_of_scope");
  });
});
