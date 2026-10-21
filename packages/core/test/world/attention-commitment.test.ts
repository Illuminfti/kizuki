import { expect, setSystemTime, test } from "bun:test";
import { applyCanonWrite } from "../../src/canon/apply";
import { worldCanonTarget } from "../../src/canon/world-materialization";
import { getClaim } from "../../src/claims/store";
import type { SituationCardV2 } from "../../src/contracts/situation-card-v2";
import { serveCorrect } from "../../src/serving/correct";
import { serveWorldView } from "../../src/serving/world-view";
import { deliverAttention } from "../../src/world/attention/deliver";
import { setAttentionDisposition } from "../../src/world/attention/state";
import { budget } from "../canon/helpers";
import { ATTENTION_WHEN } from "../helpers/attention-fixture";
import { completeEmptyWorldSummaries, EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";
import { cardFixture } from "./card-fixture";
import { runBackfill } from "../../src/ingest/run";
import { connector } from "../connections-helpers";
import type { Attention, AttentionCandidate } from "../../src/contracts/attention";
const literal = (value: string) => ({ kind: "literal" as const, value });
const vocabulary = (id: string) => ({ kind: "vocabulary" as const, ref: { kind: "vocabulary" as const, id } });

test("commitment cues use exact current deadlines and shared completion; uncertain dates stay quiet", async () => {
  setSystemTime(new Date("2030-01-01T12:00:00.000Z"));
  const f = await cardFixture(undefined, { model: EMPTY_SUMMARY_MODEL });
  try {
    const complete = () => completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const candidates = () => {
      const body = serveWorldView(f.ctx, { operation: "attention", ...ATTENTION_WHEN }).data;
      if (!("result" in body) || !("data" in body.result)) throw new Error("attention unavailable");
      return (body.result.data as Attention).states.filter((state): state is AttentionCandidate => state.state === "candidate");
    };
    const entries = [];
    for (const [name, dates, status] of [
      ["open", ["2029-12-30"], "open"], ["self-report", ["2029-12-30"], "done"],
      ["future", ["2030-01-03"], "open"], ["conflicting", ["2029-12-29", "2029-12-30"], "open"],
      ["dropped", ["2029-12-30"], "dropped"],
    ] as const) {
      const subject = `commitment:${name}`;
      await f.write("world.kind", vocabulary("world/commitment"), { subject });
      await f.write("commitment.label", literal(name), { subject });
      for (const date of dates) await f.write("commitment.due", literal(date), { subject });
      await f.write("commitment.status", vocabulary(`commitment/${status}`), { subject });
      entries.push({ name, subject });
    }
    await f.write("world.kind", vocabulary("world/situation"), { subject: "situation:deadlines" });
    await f.write("situation.label", literal("Deadline goal"), { subject: "situation:deadlines" });
    await f.write("situation.objective", literal("Finish an independently checked artifact"), { subject: "situation:deadlines" });
    for (const entry of entries) await f.write("situation.has_commitment", { kind: "subject", ref: f.ref(entry.subject) }, { subject: "situation:deadlines" });
    const capture = connector(async () => ({ display: "synthetic" })), manifest = capture.manifest();
    capture.manifest = () => ({ ...manifest, connector_id: "card.fixture", capabilities: { ...manifest.capabilities, backfill: true } });
    capture.backfill = async () => ({ events: [], cursor: "complete", has_more: false });
    expect((await runBackfill(f.db, capture, "card.fixture", f.sourceKey)).errors).toEqual([]);
    await complete();
    const discovered = serveWorldView(f.ctx, { operation: "find_situations", label: "Deadline goal", ...ATTENTION_WHEN }).data;
    if (!("result" in discovered) || !("data" in discovered.result) || !("matches" in discovered.result.data)) throw new Error("goal missing");
    const goal = discovered.result.data.matches[0]!.ref;
    const read = () => {
      const body = serveWorldView(f.ctx, { operation: "situation", situation: goal, card: "kizuki.situation-card/v2", ...ATTENTION_WHEN }).data;
      if (!("result" in body) || !("data" in body.result)) throw new Error("deadline card unavailable");
      return body.result.data as SituationCardV2;
    };
    expect(read().commitments.find(c => c.label?.object.kind === "literal" && c.label.object.value === "conflicting")?.overdue).toBe("unknown");
    expect(read().commitments.find(c => c.label?.object.kind === "literal" && c.label.object.value === "self-report")?.status).toBe("claimed_done");
    const cues = candidates().filter(cue => cue.source === "commitment_due");
    expect(cues).toHaveLength(2);
    expect(new Set(cues.map(cue => cue.cue)).size).toBe(2);
    expect(cues.every(cue => cue.subject.token === goal.token)).toBe(true);
    // Disposition is never a gate on this existing canonical write/correction.
    setAttentionDisposition(f.ctx, cues[0]!.cue, "dismiss");
    const target = entries.find(entry => entry.name === "open")!;
    const claims = f.db.query<{ claim_id: string }, [string]>("SELECT claim_id FROM claim_v2_semantics WHERE subject_id=?").all(target.subject).map(row => getClaim(f.db, row.claim_id)!);
    applyCanonWrite({ db: f.db, vault_path: f.ctx.vaultPath }, claims, worldCanonTarget(f.db, claims[0]!.claim_id), { writer: "loop", budget: budget() });
    const open = read().commitments.find(c => c.label?.object.kind === "literal" && c.label.object.value === "open")!;
    await serveCorrect(f.ctx, { statement: "The owner confirms this commitment is done.", target: { world_claim: open.statusBasis[0]! }, mode: "replace_object", object: { kind: "vocabulary", id: "commitment/done" } });
    await complete();
    expect(read().commitments.find(c => c.commitment.token === open.commitment.token)?.status).toBe("done");
    expect(candidates().filter(cue => cue.source === "commitment_due")).toHaveLength(1);
    const expired = cues.find(cue => !candidates().some(current => current.cue === cue.cue))!;
    expect(await deliverAttention(f.ctx, expired.cue)).toEqual({ status: "unavailable" });
    expect(serveWorldView(f.ctx, { operation: "attention", ...ATTENTION_WHEN, valid: { kind: "at", at: "2029-01-01T00:00:00.000Z" } }).data).toMatchObject({ result: { status: "unavailable", reason: "history" } });
  } finally { f.dispose(); setSystemTime(); }
}, 120_000);
