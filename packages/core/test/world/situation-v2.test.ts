import { expect, test } from "bun:test";
import { serveWorldView } from "../../src/serving/world-view";
import { cardFixture } from "./card-fixture";

const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const SCHEMA = "kizuki.situation-card/v2";
const literal = (value: string) => ({ kind: "literal" as const, value });
const vocabulary = (id: string) => ({ kind: "vocabulary" as const, ref: { kind: "vocabulary" as const, id } });

test("Situation v2 is opt-in and a v1-only situation keeps its attributed literal commitments", async () => {
  const f = await cardFixture();
  try {
    await f.write("world.kind", vocabulary("world/situation"), { subject: "project:launch" });
    await f.write("situation.label", literal("Launch"), { subject: "project:launch" });
    await f.write("situation.commitment", literal("Prepare the launch notes"), { subject: "project:launch" });
    const found = serveWorldView(f.ctx, { operation: "find_situations", label: "Launch", ...WHEN }).data;
    if (!("result" in found) || !("data" in found.result) || !("matches" in found.result.data)) throw new Error("situation missing");
    const input = { operation: "situation", situation: found.result.data.matches[0]!.ref, ...WHEN };
    const old = serveWorldView(f.ctx, input).data;
    const next = serveWorldView(f.ctx, { ...input, card: SCHEMA }).data;
    expect(next).toMatchObject({ result: { data: {
      schema: SCHEMA, commitments: [], decisions: [], dependencies: [],
      statedCommitments: [{ object: literal("Prepare the launch notes") }], coverage: { gaps: expect.arrayContaining(["coverage"]) },
    } } });
    const again = serveWorldView(f.ctx, input).data;
    if (!("result" in old) || !("data" in old.result) || !("result" in again) || !("data" in again.result)) throw new Error("v1 card missing");
    expect(again.result.data).toEqual(old.result.data);
  } finally { f.dispose(); }
}, 120_000);

import { situationV2Fixture } from "../helpers/situation-v2-fixture";
import { serveCorrect } from "../../src/serving/correct";
import { undoReceipt } from "../../src/canon/undo";

test("commitments keep their own identity, dates, and holder perspectives; completion self-report remains claimed_done", async () => {
  const f = await situationV2Fixture();
  try {
    await f.write("commitment.status",vocabulary("commitment/done"),{subject:"commitment:notes"});
    const card = f.readSituation();
    expect(card.commitments).toHaveLength(2);
    const notes = card.commitments.find(c => c.label?.object.kind === "literal" && c.label.object.value === "Prepare notes")!;
    expect(notes.status).toBe("claimed_done");
    expect(notes.due.map(r => r.object)).toEqual(expect.arrayContaining([literal("2026-10-23"),literal("2026-10-22")]));
    expect(new Set(notes.due.map(r => r.perspective.holder?.token)).size).toBe(2);
    expect(notes.overdue).toBe("unknown");
    const review = card.commitments.find(c => c.label?.object.kind === "literal" && c.label.object.value === "Review draft")!;
    expect(review.due.map(r => r.object)).toEqual([literal("2026-10-24")]);
    expect(review.overdue).toBe(false);
    expect(notes.commitment).not.toEqual(review.commitment);
    expect(notes.statusBasis).toHaveLength(1);
    expect(card.decisions).toMatchObject([{status:"decided"}]);
  } finally { f.dispose(); }
}, 120_000);

test("owner correction changes one commitment only, and idea correction moves the exact decision into uncertainty with reversible receipts", async () => {
  const f = await situationV2Fixture();
  try {
    f.materialize("commitment:review"); f.materialize("decision:format");
    const before = f.readSituation();
    const review = before.commitments.find(c => c.label?.object.kind === "literal" && c.label.object.value === "Review draft")!;
    const notes = before.commitments.find(c => c.commitment.token !== review.commitment.token)!;
    await serveCorrect(f.ctx,{statement:"The review is due on 25 October.",target:{world_claim:review.due[0]!.claim},mode:"replace_object",object:literal("2026-10-25")});
    expect(f.readSituation().commitments.find(c => c.commitment.token === notes.commitment.token)?.due).toEqual(notes.due);
    expect(f.readSituation().commitments.find(c => c.commitment.token === review.commitment.token)?.due.map(r => r.object)).toEqual([literal("2026-10-25")]);
    const decision = f.readSituation().decisions[0]!;
    const result = await serveCorrect(f.ctx,{statement:"That was an idea, not a decision.",target:{world_claim:decision.statement.claim},mode:"reclassify_mode",perspective_mode:"suggested"});
    expect(f.readSituation().decisions).toHaveLength(0);
    expect(f.readSituation().uncertainty).toEqual(expect.arrayContaining([expect.objectContaining({predicate:"decision.status",perspective:expect.objectContaining({mode:"suggested"})})]));
    const data = result.data;
    if (data == null || !("receipt_id" in data) || typeof data.receipt_id !== "string") throw new Error(`receipt missing ${JSON.stringify(data)}`);
    await undoReceipt({db:f.db,vault_path:f.ctx.vaultPath},data.receipt_id);
    expect(f.readSituation().decisions).toMatchObject([{status:"decided"}]);
  } finally { f.dispose(); }
}, 120_000);

test("the writer refuses inexact calendar dates and wrong typed endpoints", async () => {
  const f = await situationV2Fixture();
  try {
    for (const value of ["Friday","2026-02-30","2026-13-01","2026-10-24T25:00:00Z"]) {
      await expect(f.write("commitment.due",literal(value),{subject:"commitment:review"})).rejects.toMatchObject({code:"world_object_kind"});
    }
    await expect(f.write("situation.has_commitment",{kind:"subject",ref:f.ref("topic:bayes")},{subject:"project:launch"})).rejects.toMatchObject({code:"world_endpoint_kind"});
    await expect(f.write("commitment.debtor",{kind:"subject",ref:f.ref("project:launch")},{subject:"commitment:review"})).rejects.toMatchObject({code:"world_endpoint_kind"});
  } finally { f.dispose(); }
},120_000);
