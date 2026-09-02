import { afterEach, describe, expect, test } from "bun:test";
import { listAudit } from "../../src/agents";
import { getClaim, listClaims, listSupersessions } from "../../src/claims/store";
import { serveCorrect } from "../../src/serving/correct";
import type { CorrectArgs } from "../../src/serving/correct";
import { servePropose } from "../../src/serving/propose";
import { ServeError } from "../../src/serving/types";
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

async function refusal(run: () => Promise<unknown>): Promise<ServeError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected a ServeError");
}

/** A keyed claim an agent filed, which is what a correction retires. */
async function fileClaim(
  live: Fixture,
  body: string,
  predicate: string,
  object: string,
  subject = "person:ada",
): Promise<string> {
  const envelope = await servePropose(live.agent("reader-private"), {
    kind: "claim",
    target: `facts:${predicate}`,
    body,
    subjects: [subject],
    subject,
    predicate,
    object,
    provenance: [live.events["public"] as string],
  });
  const id = envelope.data?.claim_id;
  if (id === undefined) throw new Error("the fixture claim was not filed");
  return id;
}

describe("serveCorrect retires what the owner says is wrong", () => {
  test("a named claim is superseded and the statement is kept verbatim", async () => {
    const live = newFixture();
    const wrong = await fileClaim(
      live,
      "Ada works at Acme.",
      "employment.works_at",
      "Acme",
    );

    const envelope = await serveCorrect(live.owner(), {
      statement: "Ada left Acme last spring; she works at Grace's workshop.",
      target: { claim_id: wrong },
    });
    const data = envelope.data;
    expect(data?.superseded.map((entry) => entry.claim_id)).toEqual([wrong]);
    expect(getClaim(live.db, wrong)?.status).toBe("superseded");
    expect(getClaim(live.db, wrong)?.superseded_by).toBe(data?.claim_id ?? "");

    const correction = getClaim(live.db, data?.claim_id ?? "");
    expect(correction?.authority).toBe("owner_correction");
    expect(correction?.status).toBe("live");
    // The owner's words are evidence, stored as themselves.
    expect(correction?.body).toBe(
      "Ada left Acme last spring; she works at Grace's workshop.",
    );
    expect(
      listSupersessions(live.db).some(
        (row) => row.loser === wrong && row.rule === "R5",
      ),
    ).toBe(true);
    expect(envelope.canon).toEqual([]);
    expect(envelope.quoted).toEqual([]);
  });

  test("the statement lands in the ledger and repeats do not duplicate it", async () => {
    const live = newFixture();
    const wrong = await fileClaim(
      live,
      "Ada is based in Lagos.",
      "location.based_in",
      "Lagos",
    );
    const args: CorrectArgs = {
      statement: "Ada is based in Lisbon.",
      target: { claim_id: wrong },
    };

    const first = await serveCorrect(live.owner(), args);
    const eventId = first.data?.event_id ?? "";
    expect(eventId).not.toBe("");
    const row = live.db
      .query<{ text: string; connector_id: string; kind: string }, [string]>(
        "SELECT text, connector_id, kind FROM events WHERE event_id = ?",
      )
      .get(eventId);
    expect(row?.text).toBe("Ada is based in Lisbon.");
    expect(row?.connector_id).toBe("kizuki.owner");
    expect(row?.kind).toBe("correction");

    // The claim it contradicted is retired, so the repeat is aimed at the
    // subject: the same sentence is the same evidence and the same claim.
    const second = await serveCorrect(live.owner(), {
      statement: args.statement,
      target: { subject: "person:ada" },
    });
    expect(second.data?.event_id).toBe(eventId);
    expect(second.data?.claim_id).toBe(first.data?.claim_id ?? "");
    expect(second.data?.superseded).toEqual([]);
    expect(second.data?.answer).toContain("already recorded");
    expect(
      live.db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM events WHERE connector_id = ?",
        )
        .get("kizuki.owner")?.count,
    ).toBe(1);
  });

  test("a subject that names one group is corrected, several are reported", async () => {
    const live = newFixture();
    const based = await fileClaim(
      live,
      "Ada is based in Lagos.",
      "location.based_in",
      "Lagos",
    );

    const single = await serveCorrect(live.owner(), {
      statement: "Ada moved to Lisbon.",
      target: { subject: "person:ada" },
    });
    expect(single.data?.superseded.map((entry) => entry.claim_id)).toEqual([
      based,
    ]);

    await fileClaim(live, "Ada works at Acme.", "employment.works_at", "Acme");
    await fileClaim(
      live,
      "Ada reports to Grace.",
      "relation.reports_to",
      "Grace",
    );
    const many = await serveCorrect(live.owner(), {
      statement: "Ada does none of that any more.",
      target: { subject: "person:ada" },
    });
    // Two readings match and neither outranks the other, so the correction
    // names them and retires nothing rather than guessing.
    expect(many.data?.claim_id).toBeNull();
    expect(many.data?.event_id).toBeNull();
    // The correction filed a moment ago keeps its own key alive, so three
    // readings now sit under this subject.
    expect(many.data?.ambiguous).toHaveLength(3);
    expect(many.data?.superseded).toEqual([]);
    expect(listClaims(live.db, { status: "live" }).length).toBeGreaterThan(0);
  });

  test("an unnamed or unresolvable target fails closed", async () => {
    const live = newFixture();
    const ctx = live.owner();
    const cases: [CorrectArgs, string][] = [
      [
        { statement: "Something is wrong." },
        "invalid arguments: target: name a claim, a claim key or a subject",
      ],
      [
        {
          statement: "Something is wrong.",
          target: { claim_id: "01J000000000000000000MISS" },
        },
        "invalid arguments: target.claim_id: names no live claim",
      ],
      [
        { statement: "Something is wrong.", target: { claim_key: "not-a-key" } },
        "invalid arguments: target.claim_key: must be a claim key",
      ],
      [
        {
          statement: "Something is wrong.",
          target: { subject: "person:nobody" },
        },
        "invalid arguments: target.subject: names no live keyed claim",
      ],
      [
        {
          statement: "Something is wrong.",
          target: { subject: "person:ada", claim_key: "a".repeat(64) },
        },
        "invalid arguments: target: name exactly one of claim_id, claim_key, subject",
      ],
    ];
    for (const [args, message] of cases) {
      const error = await refusal(() => serveCorrect(ctx, args));
      expect(error.code).toBe("invalid_arguments");
      expect(error.message).toBe(message);
    }
    // Nothing was recorded on any refused path.
    expect(
      live.db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM events WHERE connector_id = ?",
        )
        .get("kizuki.owner")?.count,
    ).toBe(0);
  });

  test("a claim with no predicate cannot be corrected", async () => {
    const live = newFixture();
    const keyless = await servePropose(live.agent("reader-private"), {
      kind: "claim",
      target: "facts:keyless",
      body: "A claim with nothing to key it.",
      subjects: ["person:ada"],
      provenance: [live.events["public"] as string],
    });
    const error = await refusal(() =>
      serveCorrect(live.owner(), {
        statement: "That is wrong.",
        target: { claim_id: keyless.data?.claim_id ?? "" },
      }),
    );
    expect(error.message).toBe(
      "invalid arguments: target.claim_id: names a claim with no predicate to correct",
    );
  });

  test("a relayed correction is on the record and bounded by the grant", async () => {
    const live = newFixture();
    const wrong = await fileClaim(
      live,
      "Ada works at Acme.",
      "employment.works_at",
      "Acme",
    );

    const relayed = await serveCorrect(live.agent("reader-private"), {
      statement: "Ada works at the workshop now.",
      target: { claim_id: wrong },
    });
    const correction = getClaim(live.db, relayed.data?.claim_id ?? "");
    expect(correction?.authority).toBe("owner_correction");
    expect(correction?.frontmatter["x-relayed-by"]).toBe(
      "agent:reader-private",
    );
    expect(relayed.data?.answer).toContain("Relayed by reader-private");
    expect(
      listAudit(live.db, "reader-private", { limit: 1 })[0]?.query_shape[
        "claim_ids"
      ],
    ).toEqual([relayed.data?.claim_id as string, wrong]);

    // The claim a low-ceiling agent may not read is one it may not retire.
    const other = await fileClaim(
      live,
      "Grace is based in Lagos.",
      "location.based_in",
      "Lagos",
      "person:grace",
    );
    expect(
      (
        await refusal(() =>
          serveCorrect(live.agent("reader-personal"), {
            statement: "Grace moved.",
            target: { claim_id: other },
          }),
        )
      ).code,
    ).toBe("above_ceiling");
    expect(
      (
        await refusal(() =>
          serveCorrect(live.agent("subjected"), {
            statement: "Grace moved.",
            target: { claim_id: other },
          }),
        )
      ).code,
    ).toBe("subject_out_of_scope");
  });

  test("a refile after a correction is a duplicate, never suppressed", async () => {
    const live = newFixture();
    const ctx = live.agent("reader-private");
    const args = {
      kind: "claim" as const,
      target: "facts:employment.works_at",
      body: "Ada works at Acme.",
      subjects: ["person:ada"],
      subject: "person:ada",
      predicate: "employment.works_at",
      object: "Acme",
      provenance: [live.events["public"] as string],
    };
    const first = await servePropose(ctx, args);
    await serveCorrect(live.owner(), {
      statement: "Ada does not work at Acme.",
      target: { claim_id: first.data?.claim_id ?? "" },
    });

    // The old rejection table poisoned this body forever. A correction is
    // scoped to the claim key and reversible instead.
    const refiled = await servePropose(ctx, args);
    expect(refiled.data?.outcome).toBe("duplicate");
    expect(refiled.data?.claim_id).toBe(first.data?.claim_id ?? "");
  });

  test("a grant without the tool cannot relay a correction", async () => {
    const live = newFixture();
    const error = await refusal(() =>
      serveCorrect(live.agent("search-only"), {
        statement: "Anything at all.",
        target: { subject: "person:ada" },
      }),
    );
    expect(error.code).toBe("tool_not_granted");
  });
});
