import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyCanonWrite,
  createBudgetTracker,
  getCanonReceipt,
  resolveTarget,
} from "../../src/canon";
import { DEFAULT_GRANT, listAudit, setGrant } from "../../src/agents";
import {
  getClaim,
  insertClaim,
  listClaims,
  listSupersessions,
} from "../../src/claims/store";
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

function ownerEvents(live: Fixture): number {
  return (
    live.db
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM events WHERE connector_id = ?",
      )
      .get("kizuki.owner")?.count ?? -1
  );
}

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

  test("the statement lands in the ledger and an exact replay reuses it", async () => {
    const live = newFixture();
    const wrong = await fileClaim(
      live,
      "Ada is based in Lagos.",
      "location.based_in",
      "Lagos",
    );
    const args: CorrectArgs = {
      statement: "Ada is based in Lisbon.",
      // Keyed, not by claim id: the id the correction retires stops being a
      // live target the moment the first call lands.
      target: { claim_key: getClaim(live.db, wrong)?.claim_key ?? "" },
      object: "Lisbon",
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

    // The same sentence aimed at the same reading is the same evidence, so
    // the ledger keeps one row for it and nothing is corrected twice.
    const replay = await serveCorrect(live.owner(), args);
    expect(replay.data?.event_id).toBe(eventId);
    expect(replay.data?.claim_id).toBe(first.data?.claim_id ?? "");
    expect(replay.data?.superseded).toEqual([]);
    expect(replay.data?.answer).toContain("already recorded");
    expect(ownerEvents(live)).toBe(1);
  });

  test("one wording aimed at two targets is two records, not one", async () => {
    const live = newFixture();
    const lagos = await fileClaim(
      live,
      "Ada is based in Lagos.",
      "location.based_in",
      "Lagos",
    );
    const acme = await fileClaim(
      live,
      "Ada works at Acme.",
      "employment.works_at",
      "Acme",
    );

    const statement = "That is out of date.";
    const one = await serveCorrect(live.owner(), {
      statement,
      target: { claim_id: lagos },
    });
    const two = await serveCorrect(live.owner(), {
      statement,
      target: { claim_id: acme },
    });

    // The record id is the statement and the target it was aimed at, so two
    // corrections worded the same keep their own provenance.
    expect(one.data?.event_id).not.toBe(two.data?.event_id ?? "");
    expect(ownerEvents(live)).toBe(2);
    expect(getClaim(live.db, lagos)?.status).toBe("superseded");
    expect(getClaim(live.db, acme)?.status).toBe("superseded");
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
    const hashed = (value: string) => ({
      len: value.length,
      sha256: new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    });
    expect(
      listAudit(live.db, "reader-private", { limit: 1 })[0]?.query_shape[
        "claim_ids"
      ],
    ).toEqual([hashed(relayed.data?.claim_id as string), hashed(wrong)]);

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

  test("repeated denials never flip back into an assertion", async () => {
    const live = newFixture();
    await fileClaim(live, "Ada works at Acme.", "employment.works_at", "Acme");
    const key =
      listClaims(live.db, {
        status: "live",
        subject: "person:ada",
        keyed: true,
      })[0]?.claim_key ?? "";

    const denials = [
      "Ada does not work at acme.",
      "Ada has never worked at acme, I keep telling you.",
      "Once more: Ada does not work at acme.",
    ];
    for (const statement of denials) {
      await serveCorrect(live.owner(), { statement, target: { claim_key: key } });
      const live_ = listClaims(live.db, { claim_key: key, status: "live" });
      // Deriving the polarity from whatever is live made it alternate with
      // the count of how often the owner had spoken.
      expect(live_.map((claim) => claim.polarity)).toEqual(["negative"]);
      expect(live_[0]?.object).toBeNull();
      expect(live_[0]?.authority).toBe("owner_correction");
    }
  });

  test("a named replacement is what the store keeps, not a bare denial", async () => {
    const live = newFixture();
    const wrong = await fileClaim(
      live,
      "Ada is based in Lagos.",
      "location.based_in",
      "Lagos",
    );

    const corrected = await serveCorrect(live.owner(), {
      statement: "Ada is based in Lisbon now.",
      target: { claim_id: wrong },
      object: "Lisbon",
    });

    const filed = getClaim(live.db, corrected.data?.claim_id ?? "");
    expect(filed?.object).toBe("Lisbon");
    expect(filed?.polarity).toBe("positive");
    expect(filed?.predicate).toBe("location.based_in");
    expect(filed?.subject).toBe("person:ada");
    expect(getClaim(live.db, wrong)?.status).toBe("superseded");
  });

  test("a subject resolves past the store's default page of claims", async () => {
    const live = newFixture();
    // More live claims than one page of the claims table, so a resolver that
    // read a page and filtered it in memory sees none of the keyed claim
    // filed after them.
    for (let index = 0; index < 220; index += 1) {
      await insertClaim(
        { db: live.db },
        {
          kind: "claim",
          target: `facts:filler-${index}`,
          body: `Filler kettle reading number ${index}.`,
          subjects: ["person:grace"],
          provenance: [live.events["public"] as string],
          producer: "deterministic",
          confidence: 1,
        },
      );
    }
    const wrong = await fileClaim(
      live,
      "Ada works at Acme.",
      "employment.works_at",
      "Acme",
    );
    expect(
      listClaims(live.db, { status: "live", limit: 1_000 }).length,
    ).toBeGreaterThan(220);

    const corrected = await serveCorrect(live.owner(), {
      statement: "Ada left Acme.",
      target: { subject: "person:ada" },
    });
    expect(corrected.data?.superseded.map((entry) => entry.claim_id)).toEqual([
      wrong,
    ]);
    // Seeding two hundred claims is the point of the case, so it gets room.
  }, 30_000);

  test("a grant's window and type scope bind a correction too", async () => {
    const live = newFixture();
    const wrong = await fileClaim(
      live,
      "Ada works at Acme.",
      "employment.works_at",
      "Acme",
    );

    // The windowed agent reads nothing in this vault: every candidate falls
    // outside its grant. What it cannot read it cannot retire either.
    const windowed = await refusal(() =>
      serveCorrect(live.agent("windowed"), {
        statement: "Ada left Acme.",
        target: { claim_id: wrong },
      }),
    );
    expect(windowed.code).toBe("time_out_of_scope");

    const typed = await refusal(() =>
      serveCorrect(live.agent("typed"), {
        statement: "Ada left Acme.",
        target: { claim_id: wrong },
      }),
    );
    expect(typed.code).toBe("type_out_of_scope");
    expect(getClaim(live.db, wrong)?.status).toBe("live");
  });

  test("a grant that may not speak as the owner files one tier down", async () => {
    const live = newFixture();
    const wrong = await fileClaim(
      live,
      "Ada works at Acme.",
      "employment.works_at",
      "Acme",
    );

    const relayed = await serveCorrect(live.agent("downgraded"), {
      statement: "Ada left Acme.",
      target: { claim_id: wrong },
    });
    const filed = getClaim(live.db, relayed.data?.claim_id ?? "");
    expect(filed?.authority).toBe("owner_authored");
    expect(filed?.frontmatter["x-relayed-by"]).toBe("agent:downgraded");
  });

  test("a relay withdrawn after the session opened files one tier down", async () => {
    const live = newFixture();
    const wrong = await fileClaim(
      live,
      "Ada works at Acme.",
      "employment.works_at",
      "Acme",
    );
    // The grant is read from the store on every call, so the withdrawal has
    // to survive the write that made it, not only the object it returned.
    setGrant(live.db, "reader-private", { relay_owner_corrections: false });

    const relayed = await serveCorrect(live.agent("reader-private"), {
      statement: "Ada left Acme.",
      target: { claim_id: wrong },
    });
    expect(
      getClaim(live.db, relayed.data?.claim_id ?? "")?.authority,
    ).toBe("owner_authored");
  });

  test("a rehearsal names what it would retire and writes nothing", async () => {
    const live = newFixture();
    const wrong = await fileClaim(
      live,
      "Ada works at Acme.",
      "employment.works_at",
      "Acme",
    );

    const rehearsal = await serveCorrect(live.owner(), {
      statement: "Ada left Acme.",
      target: { claim_id: wrong },
      dry_run: true,
    });
    expect(rehearsal.data?.claim_id).toBeNull();
    expect(rehearsal.data?.event_id).toBeNull();
    expect(rehearsal.data?.superseded.map((entry) => entry.claim_id)).toEqual([
      wrong,
    ]);
    expect(getClaim(live.db, wrong)?.status).toBe("live");
    expect(ownerEvents(live)).toBe(0);
  });

  test("the page bound to a retired claim is rewritten in the same pass", async () => {
    const live = newFixture();
    // A claim the receipted writer materialized, which is what a correction
    // has to reach: the claim moves and the page moves with it.
    const filed = await insertClaim(
      { db: live.db },
      {
        kind: "claim",
        target: "facts:workplace",
        body: "Linus works at acme.",
        frontmatter: { type: "fact", title: "Where Linus works" },
        subjects: ["person:linus"],
        subject: "person:linus",
        predicate: "employment.works_at",
        object: "acme",
        provenance: [live.events["public"] as string],
        producer: "deterministic",
        confidence: 1,
      },
    );
    if (filed.outcome !== "stored") throw new Error(filed.outcome);
    const io = { db: live.db, vault_path: live.vaultPath };
    const receipt = applyCanonWrite(
      io,
      filed.claim,
      resolveTarget(io, filed.claim),
      {
        writer: "loop",
        budget: createBudgetTracker({ canon_writes_per_run: 4 }),
      },
    );
    const before = readFileSync(
      join(live.vaultPath, receipt.page_path),
      "utf8",
    );
    expect(before).toContain("Linus works at acme.");

    const corrected = await serveCorrect(live.owner(), {
      statement: "Linus works at the workshop, not at acme.",
      target: { claim_id: filed.claim.claim_id },
      object: "the workshop",
    });

    const rewritten = corrected.data?.rewritten ?? [];
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]?.page_path).toBe(receipt.page_path);
    expect(corrected.data?.receipt_id).toBe(rewritten[0]?.receipt_id ?? "");
    const after = readFileSync(join(live.vaultPath, receipt.page_path), "utf8");
    expect(after).toContain("Linus works at the workshop, not at acme.");
    expect(after).not.toContain("Linus works at acme.");
    expect(rewritten[0]?.diff).toContain("-Linus works at acme.");
    expect(rewritten[0]?.diff).toContain(
      "+Linus works at the workshop, not at acme.",
    );
    // The receipt is the reversal: bytes before, bytes after, one id.
    const stored = getCanonReceipt(live.db, rewritten[0]?.receipt_id ?? "");
    expect(stored?.writer).toBe("correction");
    expect(stored?.before_hash).toBe(rewritten[0]?.before_hash ?? null);
    expect(stored?.after_hash).toBe(rewritten[0]?.after_hash ?? "");
    expect(corrected.data?.answer).toContain(receipt.page_path);
    expect(corrected.data?.answer).toContain(rewritten[0]?.receipt_id ?? "");
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

  test("the default grant does not carry the relay", async () => {
    const live = newFixture();
    const wrong = await fileClaim(
      live,
      "Ada works at Acme.",
      "employment.works_at",
      "Acme",
    );
    expect(DEFAULT_GRANT.tools).not.toContain("correct");

    // An agent nobody wrote a grant for speaks at the top authority tier and
    // retires live claims only if someone chose to let it.
    const error = await refusal(() =>
      serveCorrect(live.agent("plain"), {
        statement: "Ada left Acme.",
        target: { claim_id: wrong },
      }),
    );
    expect(error.code).toBe("tool_not_granted");
    expect(getClaim(live.db, wrong)?.status).toBe("live");
  });
});
