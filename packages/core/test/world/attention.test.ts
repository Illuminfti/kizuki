import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { setAttentionDisposition } from "../../src/world/attention/state";
import { deliverAttention, deliverPendingAttention } from "../../src/world/attention/deliver";
import { serveWorldView } from "../../src/serving/world-view";
import { accept } from "../../src/ledger/ledger";
import { validEvent } from "../fixtures";
import { ulid } from "../../src/util/ulid";
import { attentionFixture, ATTENTION_WHEN } from "../helpers/attention-fixture";
import { bindSourceModelPort } from "../../src/ledger/source-grants";
import type { LlmPort } from "../../src/contracts/llm";
import { writeRailCursor } from "../../src/ledger/checkpoints";
import { runWorldJobs } from "../../src/serve/world-jobs";
import { EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "../../../../rfcs/fixtures", `${name}-design.json`), "utf8"));

test("48 nonmaterial mentions are quiet, with an explicit reason and no interrupt", async () => {
  const oracle = fixture("world-cue-quiet"), f = await attentionFixture({ blocker: false });
  try {
    for (let i = 0; i < oracle.candidate.mention_count; i++) accept(f.db, { ...validEvent(), connector_id: "fixture", source_record_id: ulid(), text: "A repeated mention without a material change", subjects: [{ subject_id: "situation:attention", role: "about" }] }, { source: { source_key: f.situation.sourceKey, expected_revision: 1 } });
    await f.complete();
    expect(f.read().states).toEqual([{ state: "quiet", reason: oracle.delivery.quiet_reason }]);
    expect(await deliverPendingAttention(f.ctx)).toEqual({ delivered: 0, duplicate: 0, pending: 0 });
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM world_attention_state").get()!.n).toBe(0);
  } finally { f.dispose(); }
}, 120_000);

test("an actual rejected consolidation call is provider failure, never quiet", async () => {
  const f = await attentionFixture({ complete: false }); let calls = 0;
  try {
    const event = f.db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id=?").get(f.situation.eventId)!;
    writeRailCursor(f.db, "kizuki.producer.model", "extract", `${event.accepted_at}\t${f.situation.eventId}`);
    const llm = bindSourceModelPort({ descriptor: { id: "synthetic.attention-failure", kind: "llm", contract: "kizuki.llm/v1", contract_minor: 0, supports: ["chat"], requires_lease: false, optional_package: null },
      model_ref: "synthetic.attention-failure", health: async () => ({ status: "ready", detail: {} }), close: async () => {},
      complete: async () => { calls++; return { text: "invalid response", model: EMPTY_SUMMARY_MODEL.model, usage: { input_tokens: 1, output_tokens: 1 } }; },
    } satisfies LlmPort, EMPTY_SUMMARY_MODEL);
    await runWorldJobs({ db: f.db, vaultPath: f.vault.path, now: () => new Date().toISOString(), stopRequested: () => false, modelConfigured: true, llm });
    expect(calls).toBeGreaterThan(0);
    expect(f.read().states).toContainEqual({ state: "provider_failure", reason: "provider_error" });
    expect(f.read().states.some(state => state.state === "quiet")).toBe(false);
    expect(await deliverPendingAttention(f.ctx)).toMatchObject({ delivered: 0 });
  } finally { f.dispose(); }
}, 120_000);

test("visible disagreement produces uncertainty instead of a single asserted blocker", async () => {
  const f = await attentionFixture({ blocker: false });
  try {
    await f.seed("situation:uncertain", { predicates: [
      { predicate: "situation.objective", object: { kind: "literal", value: "Deliver an independently checked artifact" } },
      { predicate: "situation.blocker", object: { kind: "literal", value: "Inspection is blocked" }, polarity: "negative" },
    ] });
    await f.complete();
    expect(f.candidates().map(cue => cue.source)).toEqual(["uncertainty"]);
  } finally { f.dispose(); }
}, 120_000);

test("explicit objective supplies relevance and delivery has its own bounded budget", async () => {
  const f = await attentionFixture({ objective: false });
  try {
    expect(f.candidates()).toHaveLength(0);
    for (let index = 0; index < 10; index++) await f.seed(`situation:relevant-${index}`, { predicates: [
      { predicate: "situation.objective", object: { kind: "literal", value: "Inspect the artifact" } },
      { predicate: "situation.blocker", object: { kind: "literal", value: "Independent review is blocked" } },
    ] });
    await f.complete();
    expect(f.candidates()).toHaveLength(10);
    expect(await deliverPendingAttention(f.ctx)).toEqual({ delivered: 4, duplicate: 0, pending: 6 });
  } finally { f.dispose(); }
}, 120_000);

test("dismissal and snooze affect only attention, with historical reads explicitly unavailable", async () => {
  const oracle = fixture("world-cue-dismissal"), f = await attentionFixture();
  try {
    const cue = f.candidates()[0]!;
    const before = f.db.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all();
    const support = f.db.query("SELECT support_key,admission FROM claim_v2_support ORDER BY support_key").all();
    expect(setAttentionDisposition(f.ctx, cue.cue, "dismiss").disposition).toBe("dismissed");
    expect(await deliverAttention(f.ctx, cue.cue)).toEqual({ status: "suppressed" });
    expect(f.db.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all()).toEqual(before);
    expect(f.db.query("SELECT support_key,admission FROM claim_v2_support ORDER BY support_key").all()).toEqual(support);
    expect(oracle.oracle.canon_gated).toBe(false);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM canon_receipts").get()!.n).toBe(0);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect(setAttentionDisposition(f.ctx, cue.cue, "snooze", until)).toMatchObject({ disposition: "snoozed", snoozedUntil: until });
    expect(await deliverPendingAttention(f.ctx)).toEqual({ delivered: 0, duplicate: 0, pending: 0 });
    expect(serveWorldView(f.ctx, { operation: "attention", ...ATTENTION_WHEN, knownAt: { kind: "time", at: "2026-01-01T00:00:00.000Z" } }).data).toMatchObject({ result: { status: "unavailable", reason: "history" } });
  } finally { f.dispose(); }
}, 120_000);

test("file notifier returns duplicate for a repeated candidate and preserves one brief line", async () => {
  const f = await attentionFixture();
  try {
    const cue = f.candidates()[0]!.cue;
    expect(await deliverAttention(f.ctx, cue)).toMatchObject({ status: "delivered", receipt: { duplicate: false } });
    const path = join(f.vault.path, "dashboards", `attention-${cue}.md`), before = statSync(path).mtimeMs;
    expect(await deliverAttention(f.ctx, cue)).toMatchObject({ status: "delivered", receipt: { duplicate: true } });
    expect(statSync(path).mtimeMs).toBe(before);
    expect(readFileSync(path, "utf8").split("\n").filter(line => line.startsWith("- "))).toHaveLength(1);
    expect(readdirSync(join(f.vault.path, "dashboards")).filter(name => name.startsWith("attention-"))).toHaveLength(1);
  } finally { f.dispose(); }
}, 120_000);

test("missing coverage, stale consolidation, provider failure and quiet stay distinct", async () => {
  const oracle = fixture("world-cue-coverage"), missing = await attentionFixture({ coverage: false }), stale = await attentionFixture({ complete: false });
  try {
    expect(missing.read().states).toContainEqual({ state: "missing_coverage", reason: oracle.states.missing_coverage.reason });
    expect(stale.read().states).toContainEqual({ state: "stale_consolidation", reason: oracle.states.stale_consolidation.reason });
    expect(stale.read().states).toContainEqual({ state: "provider_failure", reason: oracle.states.provider_failure.reason });
    expect(missing.read().states.some(state => state.state === "quiet")).toBe(false);
    expect(stale.read().states.some(state => state.state === "quiet")).toBe(false);
    expect(await deliverPendingAttention(stale.ctx)).toMatchObject({ delivered: 0 });
  } finally { missing.dispose(); stale.dispose(); }
}, 120_000);

test("new visible evidence makes an old goal summary stale and holds delivery", async () => {
  const f = await attentionFixture();
  try {
    expect(f.read().coverage.status).toBe("complete_for_query");
    await f.seed("situation:attention", { sourceKey: f.situation.sourceKey, predicates: [
      { predicate: "situation.change", object: { kind: "literal", value: "An independent review was requested" } },
    ] });
    expect(f.read().states).toContainEqual({ state: "stale_consolidation", reason: "summary_older_than_ledger" });
    expect(f.candidates().some(cue => cue.source === "stale_summary")).toBe(true);
    expect(await deliverPendingAttention(f.ctx)).toMatchObject({ delivered: 0 });
  } finally { f.dispose(); }
}, 120_000);
