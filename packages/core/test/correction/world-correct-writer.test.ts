import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { undoReceipt } from "../../src/canon/undo";
import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import { getClaim, insertClaim } from "../../src/claims/store";
import { correct } from "../../src/correction/correct";
import { CorrectError } from "../../src/correction/errors";
import { openLedger } from "../../src/ledger/db";
import { assertWorldState } from "../../src/world/integrity";
import { claimInput, putEvent } from "../claims/helpers";
import { correctionKit } from "../helpers/world-correct-kit";
import { tempVault } from "../helpers/vault";

// Every case builds a ledger and rewrites canon pages, and the host is often loaded.
setDefaultTimeout(120_000);

async function scene() {
  const vault = tempVault();
  const db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  const kit = correctionKit(db, vault.path);
  await kit.declare("concept", "topic:bayes", "Bayesian updating");
  await kit.declare("concept", "topic:prob", "Probability theory");
  await kit.declare("concept", "topic:logic", "Formal logic");
  const [kind] = await kit.declare("concept", "topic:kinds", "Kinds of belief");
  const definition = await kit.write({
    subject: "topic:bayes",
    predicate: "concept.definition",
    object: { literal: "Revise beliefs using evidence" },
  });
  const requires = await kit.write({
    subject: "topic:bayes",
    predicate: "concept.requires",
    object: { subject: "topic:prob" },
  });
  kit.materialize("topic:bayes");
  const io = { db, vault_path: vault.path };
  const evidence = () =>
    db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM native_owner_evidence",
      )
      .get()!.n;
  return {
    vault,
    db,
    kit,
    io,
    kind: kind!,
    definition,
    requires,
    evidence,
    dispose: () => (db.close(), vault.dispose()),
  };
}

test("the writer files a node-object replacement through a raw ref and undo restores the edge", async () => {
  const s = await scene();
  try {
    const done = await correct(s.io, {
      statement: "It needs formal logic.",
      target: { claim_id: s.requires },
      world: {
        mode: "replace_object",
        object: { kind: "subject", ref: s.kit.ref("topic:logic") },
      },
    });
    expect(done.superseded.map((row) => row.claim_id)).toEqual([s.requires]);
    expect(done.receipt_id).toBeString();
    expect(readClaimV2Semantic(s.db, done.claim_ids[0]!)).toMatchObject({
      object: { kind: "subject", ref: { id: "topic:logic" } },
    });
    assertWorldState(s.db);
    await undoReceipt(s.io, done.receipt_id!);
    expect(getClaim(s.db, s.requires)!.status).toBe("live");
  } finally {
    s.dispose();
  }
});

test("the writer refuses before recording: an unknown node, a wrong object kind, an unsupported claim, a long statement and a grant without the relay", async () => {
  const s = await scene();
  try {
    const refused = async (
      input: Parameters<typeof correct>[1],
      code: CorrectError["code"],
      message: string,
      io = s.io,
    ) => {
      const caught = await correct(io, input).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(CorrectError);
      expect((caught as CorrectError).code).toBe(code);
      expect((caught as CorrectError).detail).toContain(message);
      expect(s.evidence()).toBe(0);
    };
    await refused(
      {
        statement: "It needs nothing.",
        target: { claim_id: s.requires },
        world: {
          mode: "replace_object",
          object: { kind: "subject", ref: s.kit.ref("topic:nowhere") },
        },
      },
      "correction_refused",
      "names no known node",
    );
    await refused(
      { statement: "It needs logic.", target: { claim_id: s.requires } },
      "correction_refused",
      "world_object_kind",
    );
    await refused(
      { statement: "Actually a situation.", target: { claim_id: s.kind } },
      "unsupported_assertion",
      "classification_claim",
    );
    const quoted = await s.kit.write({
      subject: "topic:bayes", predicate: "concept.counterexample",
      object: { literal: "Frequentist tests" }, mode: "quoted", speaker: "person:sam",
    });
    const meaning = readClaimV2Semantic(s.db, quoted);
    for (const world of [
      { mode: "replace_object" },
      { mode: "retract" },
      { mode: "reclassify_mode", to: "suggested" },
    ] as const) {
      await refused(
        { statement: "Nope, wrong.", target: { claim_id: quoted }, world },
        "unsupported_assertion", "quoted_attribution",
      );
      expect(getClaim(s.db, quoted)!.status).toBe("live");
      expect(readClaimV2Semantic(s.db, quoted)).toEqual(meaning);
    }
    await refused(
      { statement: "x".repeat(401), target: { claim_id: s.definition } },
      "statement_invalid",
      "400 characters",
    );
    await refused(
      {
        statement: "Not so.",
        target: { claim_id: s.definition },
        world: { mode: "retract" },
      },
      "below_authority",
      "may not relay",
      {
        ...s.io,
        relay_owner_corrections: false,
      } as never,
    );
    expect(getClaim(s.db, s.definition)!.status).toBe("live");
  } finally {
    s.dispose();
  }
});

test("a mode aimed at a legacy claim is refused before anything is recorded", async () => {
  const s = await scene();
  try {
    const stored = await insertClaim({ db: s.db }, claimInput(putEvent(s.db)));
    if (stored.outcome !== "stored") throw new Error(`legacy claim was ${stored.outcome}`);
    const caught = await correct(s.io, {
      statement: "x",
      target: { claim_id: stored.claim.claim_id },
      world: { mode: "retract" },
    }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(CorrectError);
    expect((caught as CorrectError).code).toBe("correction_refused");
    expect(s.evidence()).toBe(0);
  } finally {
    s.dispose();
  }
});

test("a replayed request returns its recorded correction and adds nothing", async () => {
  const s = await scene();
  try {
    const input = {
      statement: "Not so.",
      target: { claim_id: s.definition },
      world: { mode: "retract" as const },
    };
    const first = await correct(s.io, input);
    const claims = () =>
      s.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!
        .n;
    const filed = claims();
    const replay = await correct(s.io, input);
    expect(replay.claim_ids).toEqual(first.claim_ids);
    expect(replay.event_id).toBe(first.event_id);
    expect(claims()).toBe(filed);
    expect(s.evidence()).toBe(1);
  } finally {
    s.dispose();
  }
});
