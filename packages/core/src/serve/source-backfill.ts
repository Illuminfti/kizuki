import type { Database } from "bun:sqlite";
import { assertPositiveAuthorityMutationAllowed } from "../canon/positive-authority";
import { inspectCanonRecovery } from "../canon/write-intent";
import { prepareClaimInsert, type PreparedClaimInsert } from "../claims/store";
import { semanticKey } from "../claims/claim-v2-keys";
import { parseWorldAdmission, completeWorldAnchors } from "../contracts/world-admission";
import type { ProducerV2Port } from "../contracts/producer-v2";
import type { ModelUsage } from "../contracts/producer";
import { isUtf16TextBoundary, MAX_V2_QUOTED_UTF16 } from "../contracts/producer-v2";
import { readLiveEvent } from "../ledger/ledger";
import { validateEventOrigin } from "../ledger/event-origin";
import { inspectSourceGrant, sourceEventsAllowed, sourcePolicyEpoch, sourcePortBindingDigest } from "../ledger/source-grants";
import { modelProducerFingerprint, modelProducerInputTokenOverhead } from "../producer/fingerprint";
import { planModelExtractionV2 } from "../producer/model-v2";
import { invokeProducerV2 } from "../producer/result";
import { canonicalJson, sha256Hex } from "../util/hash";
import { cloneExactJson, isPlainObject } from "../util/validate";
import { isUlid } from "../util/ulid";
import { withVaultMutationSync } from "../vault/mutation-scope";
import { acquireLease, leaseState, releaseLease, thisProcess } from "./leases";
import { readVaultId } from "./vault-id";
import { loadServeConfig } from "./config";
import { groundedWorldInput } from "./world-grounding";
import { journalWorldDrafts } from "./extract";
import { addDailyBudget, budgetDay, readDailyBudget } from "./budget-ledger";

const SCHEMA = "kizuki.source-prefix-backfill/v1" as const;
const MAX_ROWS = 256;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const token = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => isPlainObject(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export class SourceBackfillError extends Error {
  constructor(readonly code: "invalid_plan" | "source_changed" | "producer_changed" | "inventory_changed" |
    "state_changed" | "backfill_conflict" | "writer_busy" | "unsettled_work" | "budget_exhausted" | "admission_refused") {
    super(`source backfill refused: ${code}`); this.name = "SourceBackfillError";
  }
}
function refuse(code: SourceBackfillError["code"]): never { throw new SourceBackfillError(code); }

export interface SourceBackfillPlan {
  readonly schema: typeof SCHEMA;
  readonly operation_id: string;
  readonly vault_id: string;
  readonly event_id: string;
  readonly connector_id: string;
  readonly source_key: string;
  readonly content_hash: string;
  readonly text_hash: string;
  readonly source_revision: number;
  readonly source_policy_digest: string;
  readonly source_epoch: number;
  readonly producer_fingerprint: string;
  readonly model_binding_digest: string;
  readonly window: { readonly start_utf16: number; readonly end_utf16: number; readonly cap_utf16: number };
  readonly inventory_sha256: string;
  readonly state_sha256: string;
  readonly run_receipts: readonly { readonly run_id: string; readonly sha256: string }[];
  readonly review: { readonly compatible_prior_claims_sha256: string; readonly qualification_sha256: string; readonly producer_review_sha256: string };
  readonly budget: { readonly max_input_tokens: number; readonly max_output_tokens: number; readonly input_token_overhead: number };
  readonly predecessor: null | { readonly operation_id: string; readonly receipt_sha256: string };
}

export function parseSourceBackfillPlan(raw: unknown): SourceBackfillPlan {
  const errors: string[] = [];
  const value = cloneExactJson(raw, "plan", { maxDepth: 5, maxKeysPerObject: 24, maxArrayLength: 8,
    maxStringBytes: 256, maxKeyBytes: 64, maxTotalBytes: 16_384 }, errors);
  if (errors.length || !exact(value, ["schema", "operation_id", "vault_id", "event_id", "connector_id", "source_key",
    "content_hash", "text_hash", "source_revision", "source_policy_digest", "source_epoch", "producer_fingerprint",
    "model_binding_digest", "window", "inventory_sha256", "state_sha256", "run_receipts", "review", "budget", "predecessor"]) ||
    value.schema !== SCHEMA || ![value.operation_id, value.vault_id, value.connector_id, value.source_key].every(token) ||
    !isUlid(value.event_id) || ![value.content_hash, value.text_hash, value.source_policy_digest, value.producer_fingerprint,
      value.model_binding_digest, value.inventory_sha256, value.state_sha256].every(digest) ||
    ![value.source_revision, value.source_epoch].every(v => Number.isSafeInteger(v) && Number(v) > 0)) refuse("invalid_plan");
  const window = value.window, budget = value.budget, review = value.review;
  if (!exact(window, ["start_utf16", "end_utf16", "cap_utf16"]) ||
    !Object.values(window).every(Number.isSafeInteger) || Number(window.start_utf16) < 0 ||
    Number(window.start_utf16) >= Number(window.end_utf16) || Number(window.end_utf16) > Number(window.cap_utf16) ||
    Number(window.end_utf16) - Number(window.start_utf16) > MAX_V2_QUOTED_UTF16 || !exact(budget, ["max_input_tokens", "max_output_tokens", "input_token_overhead"]) ||
    !Object.values(budget).every(Number.isSafeInteger) || Number(budget.max_input_tokens) < 2000 || Number(budget.max_input_tokens) > 32000 ||
    Number(budget.max_output_tokens) < 1 || Number(budget.max_output_tokens) > 16384 ||
    Number(budget.input_token_overhead) < 0 || Number(budget.input_token_overhead) > 32000 ||
    !exact(review, ["compatible_prior_claims_sha256", "qualification_sha256", "producer_review_sha256"]) ||
    !Object.values(review).every(digest) || !Array.isArray(value.run_receipts) || value.run_receipts.length < 1 ||
    value.run_receipts.length > 8 || !value.run_receipts.every(r => exact(r, ["run_id", "sha256"]) && token(r.run_id) && digest(r.sha256)) ||
    new Set(value.run_receipts.map(r => (r as Record<string, unknown>).run_id)).size !== value.run_receipts.length ||
    !(value.predecessor === null || exact(value.predecessor, ["operation_id", "receipt_sha256"]) &&
      token(value.predecessor.operation_id) && digest(value.predecessor.receipt_sha256) && value.predecessor.operation_id !== value.operation_id)) refuse("invalid_plan");
  return value as unknown as SourceBackfillPlan;
}

interface Inventory {
  claims: Record<string, unknown>[];
  semantics: Record<string, unknown>[];
  supports: Record<string, unknown>[];
  support_events: Record<string, unknown>[];
  observations: Record<string, unknown>[];
  observation_events: Record<string, unknown>[];
}
function bounded(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (rows.length > MAX_ROWS || Buffer.byteLength(canonicalJson(rows)) > 2 * 1024 * 1024) refuse("inventory_changed");
  return rows;
}
function inventory(db: Database, eventId: string): Inventory {
  const claims = bounded(db.query<Record<string, unknown>, [string, string]>(`SELECT c.* FROM claims c WHERE
    EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(c.provenance) THEN c.provenance ELSE '[]' END) p WHERE p.value=?)
    OR EXISTS(SELECT 1 FROM claim_v2_support s JOIN claim_v2_support_events e USING(support_key) WHERE s.claim_id=c.claim_id AND e.event_id=?)
    ORDER BY c.claim_id LIMIT 257`).all(eventId, eventId));
  const ids = canonicalJson(claims.map(c => c.claim_id));
  return { claims,
    semantics: bounded(db.query<Record<string, unknown>, [string]>("SELECT * FROM claim_v2_semantics WHERE claim_id IN (SELECT value FROM json_each(?)) ORDER BY claim_id LIMIT 257").all(ids)),
    supports: bounded(db.query<Record<string, unknown>, [string]>("SELECT * FROM claim_v2_support WHERE claim_id IN (SELECT value FROM json_each(?)) ORDER BY support_key LIMIT 257").all(ids)),
    support_events: bounded(db.query<Record<string, unknown>, [string]>("SELECT e.* FROM claim_v2_support_events e JOIN claim_v2_support s USING(support_key) WHERE s.claim_id IN (SELECT value FROM json_each(?)) ORDER BY e.support_key,e.event_id LIMIT 257").all(ids)),
    observations: bounded(db.query<Record<string, unknown>, [string]>("SELECT o.* FROM world_observations o JOIN claim_v2_support s USING(support_key) WHERE s.claim_id IN (SELECT value FROM json_each(?)) ORDER BY o.observation_id LIMIT 257").all(ids)),
    observation_events: bounded(db.query<Record<string, unknown>, [string]>("SELECT e.* FROM world_observation_events e JOIN world_observations o USING(observation_id) JOIN claim_v2_support s USING(support_key) WHERE s.claim_id IN (SELECT value FROM json_each(?)) ORDER BY e.observation_id,e.event_id LIMIT 257").all(ids)) };
}
function state(db: Database, eventId: string) {
  return {
    checkpoints: bounded(db.query<Record<string, unknown>, [string]>("SELECT * FROM checkpoints WHERE source_key=(SELECT source_key FROM source_event_bindings WHERE event_id=?) ORDER BY connector_id,source_key LIMIT 257").all(eventId)),
    connections: bounded(db.query<Record<string, unknown>, [string]>("SELECT * FROM connections WHERE source_key=(SELECT source_key FROM source_event_bindings WHERE event_id=?) ORDER BY connector_id,source_key LIMIT 257").all(eventId)),
    cursors: bounded(db.query<Record<string, unknown>, []>("SELECT * FROM rail_cursors ORDER BY rail,source_key LIMIT 257").all()),
    progress: bounded(db.query<Record<string, unknown>, [string]>("SELECT * FROM extract_oversized_records WHERE event_id=?").all(eventId)),
    deferred: bounded(db.query<Record<string, unknown>, [string]>("SELECT * FROM extract_deferred_inputs WHERE event_id=?").all(eventId)),
    settlements: bounded(db.query<Record<string, unknown>, [string]>("SELECT * FROM extract_segment_settlements WHERE event_id=? ORDER BY decision_id LIMIT 257").all(eventId)),
    replays: bounded(db.query<Record<string, unknown>, [string]>("SELECT * FROM extract_replay_receipts WHERE event_id=? ORDER BY operation_id LIMIT 257").all(eventId)),
  };
}

/** Read-only custody metadata; hashes attest bytes, never natural-language compatibility. */
export function sourceBackfillSnapshot(db: Database, eventId: string) {
  if (!isUlid(eventId)) refuse("invalid_plan");
  return db.transaction(() => ({ inventory_sha256: sha256Hex(canonicalJson(inventory(db, eventId))),
    state_sha256: sha256Hex(canonicalJson(state(db, eventId))) })).immediate();
}

type Target = { readonly db: Database; readonly vault_path: string; readonly producer: ProducerV2Port };
function locked<T>(target: Target, work: () => T): T {
  return withVaultMutationSync(target, () => {
    const process = thisProcess();
    if (leaseState(target.db, process) !== "free" || !acquireLease(target.db, process).acquired) refuse("writer_busy");
    try { return target.db.transaction(work).immediate(); }
    finally { releaseLease(target.db, process); }
  });
}
function current(target: Target, plan: SourceBackfillPlan, alreadySettled = false) {
  const { db, producer, vault_path } = target;
  assertPositiveAuthorityMutationAllowed(db);
  if (readVaultId(vault_path) !== plan.vault_id) refuse("source_changed");
  if (modelProducerFingerprint(producer) !== plan.producer_fingerprint || sourcePortBindingDigest(producer) !== plan.model_binding_digest ||
      modelProducerInputTokenOverhead(producer) !== plan.budget.input_token_overhead) refuse("producer_changed");
  const event = readLiveEvent(db, plan.event_id), grant = inspectSourceGrant(db, plan.source_key);
  const binding = db.query<{ source_key: string }, [string]>("SELECT source_key FROM source_event_bindings WHERE event_id=?").get(plan.event_id);
  if (event === null || event.connector_id !== plan.connector_id || event.content_hash !== plan.content_hash || event.text_hash !== plan.text_hash ||
      validateEventOrigin(db, event).origin !== "external" || binding?.source_key !== plan.source_key || grant?.status !== "active" ||
      grant.revision !== plan.source_revision || grant.policy_digest !== plan.source_policy_digest || sourcePolicyEpoch(db) !== plan.source_epoch ||
      !sourceEventsAllowed(db, [plan.event_id], { owner: false, model: true, purpose: "extract", port: producer }) ||
      plan.window.cap_utf16 > event.text.length || !Object.values(plan.window).every(n => isUtf16TextBoundary(event.text, n))) refuse("source_changed");
  const progress = db.query<{ done_utf16: number; pending_end_utf16: number | null; replay_operation_id: string | null }, [string]>(
    "SELECT done_utf16,pending_end_utf16,replay_operation_id FROM extract_oversized_records WHERE event_id=?").get(plan.event_id);
  if (progress === null || progress.done_utf16 !== plan.window.cap_utf16 || progress.pending_end_utf16 !== null || progress.replay_operation_id !== null) refuse("state_changed");
  const config = loadServeConfig(vault_path).extraction;
  if (config.max_input_tokens !== plan.budget.max_input_tokens || config.max_output_tokens !== plan.budget.max_output_tokens) refuse("budget_exhausted");
  const canon = inspectCanonRecovery(db);
  if (canon.pending || canon.projection_pending !== 0 || db.query("SELECT 1 FROM extract_batches LIMIT 1").get() ||
      db.query("SELECT 1 FROM extract_usage LIMIT 1").get() || db.query("SELECT 1 FROM purge_ops WHERE state<>'done' LIMIT 1").get()) refuse("unsettled_work");
  const old = inventory(db, plan.event_id);
  const active = old.claims.filter(c => ["model", "llm"].includes(String(c.producer)) && c.authority === "model_inference" &&
    c.status === "live" && c.retracted_at === null && c.superseded_by === null);
  // Retired connector captures remain in the snapshot and every preservation check.
  // They cannot contribute world semantics, support, or its observation children.
  const retired = old.claims.filter(c => c.producer === "deterministic" && c.authority === "connector_evidence" &&
    c.is_world_typed === 0 && c.status === "superseded" && typeof c.retracted_at === "string" && c.retracted_at.length > 0 &&
    typeof c.superseded_by === "string" && c.superseded_by.length > 0 && typeof c.receipt_id === "string" && c.receipt_id.length > 0);
  if (active.length === 0 || active.length + retired.length !== old.claims.length ||
      old.claims.some(c => canonicalJson(JSON.parse(String(c.provenance))) !== canonicalJson([plan.event_id])) ||
      retired.some(c => old.semantics.some(s => s.claim_id === c.claim_id) || old.supports.some(s => s.claim_id === c.claim_id)) ||
      old.semantics.length !== active.length || old.supports.length === 0 || old.supports.some(s => s.source_key !== plan.source_key || s.support_origin !== "source") ||
      old.support_events.some(s => s.event_id !== plan.event_id || s.event_content_hash !== plan.content_hash)) refuse("inventory_changed");
  for (const support of old.supports) {
    const admission = parseWorldAdmission(JSON.parse(String(support.admission)));
    if (admission === null || completeWorldAnchors(admission.semantic).some(a => a.event_id !== plan.event_id || a.start_utf16 < 0 || a.end_utf16 > plan.window.cap_utf16)) refuse("inventory_changed");
  }
  if (!alreadySettled && sha256Hex(canonicalJson(old)) !== plan.inventory_sha256) refuse("inventory_changed");
  if (sha256Hex(canonicalJson(state(db, plan.event_id))) !== plan.state_sha256) refuse("state_changed");
  for (const receipt of plan.run_receipts) {
    const run = db.query<{ report: string }, [string]>("SELECT report FROM run_receipts WHERE run_id=?").get(receipt.run_id);
    if (run === null || sha256Hex(run.report) !== receipt.sha256) refuse("state_changed");
  }
  return { event, old, config };
}

export interface SourceBackfillResult {
  readonly schema: "kizuki.source-prefix-backfill-result/v1";
  readonly operation_id: string;
  readonly plan_sha256: string;
  readonly outcome: "settled" | "rejected" | "failed";
  readonly usage: ModelUsage | null;
  readonly usage_known: boolean;
  readonly claims_added: readonly string[];
  readonly supports_added: number;
  readonly carried_forward: number;
  readonly response_sha256: string | null;
  readonly reason: string | null;
}

/** Exactly one attempt; interrupted reservations cannot be resumed or retried. No ordinary cursor is touched. */
export async function backfillSourceWindow(target: Target, raw: unknown): Promise<SourceBackfillResult> {
  const plan = parseSourceBackfillPlan(raw), planBytes = canonicalJson(plan), planHash = sha256Hex(planBytes), { db, producer } = target;
  let prior: SourceBackfillResult | undefined;
  const initial = locked(target, () => {
    const attempt = db.query<{ operation_id: string; plan_sha256: string }, [string, string, string]>("SELECT operation_id,plan_sha256 FROM source_backfill_attempts WHERE event_id=? AND producer_fingerprint=? AND model_binding_digest=?").get(plan.event_id, plan.producer_fingerprint, plan.model_binding_digest);
    if (attempt !== null) {
      if (attempt.operation_id !== plan.operation_id || attempt.plan_sha256 !== planHash) refuse("backfill_conflict");
      const result = db.query<{ report: string }, [string]>("SELECT report FROM source_backfill_results WHERE operation_id=?").get(plan.operation_id);
      if (result === null) refuse("backfill_conflict");
      current(target, plan, true);
      prior = JSON.parse(result.report) as SourceBackfillResult;
      if (prior.schema !== "kizuki.source-prefix-backfill-result/v1" || prior.operation_id !== plan.operation_id ||
          prior.plan_sha256 !== planHash || !["settled", "rejected", "failed"].includes(prior.outcome)) refuse("backfill_conflict");
      return null;
    }
    const ancestors = db.query<{ operation_id: string; producer_fingerprint: string; model_binding_digest: string; plan: string; report: string | null }, [string]>(
      `SELECT a.operation_id,a.producer_fingerprint,a.model_binding_digest,a.plan,r.report FROM source_backfill_attempts a
       LEFT JOIN source_backfill_results r USING(operation_id) WHERE a.event_id=? ORDER BY a.created_at,a.operation_id LIMIT 17`).all(plan.event_id);
    if (ancestors.length >= 16 || ancestors.some(a => a.report === null)) refuse("backfill_conflict");
    if (ancestors.length === 0) {
      if (plan.predecessor !== null) refuse("backfill_conflict");
    } else {
      if (plan.predecessor === null) refuse("backfill_conflict");
      const parent = ancestors.find(a => a.operation_id === plan.predecessor!.operation_id);
      if (parent === undefined || (parent.producer_fingerprint === plan.producer_fingerprint && parent.model_binding_digest === plan.model_binding_digest) ||
          sha256Hex(parent.report!) !== plan.predecessor.receipt_sha256 ||
          ancestors.some(a => parseSourceBackfillPlan(JSON.parse(a.plan)).predecessor?.operation_id === parent.operation_id)) refuse("backfill_conflict");
      const previous = parseSourceBackfillPlan(JSON.parse(parent.plan));
      if (previous.content_hash !== plan.content_hash || previous.text_hash !== plan.text_hash || previous.source_key !== plan.source_key ||
          canonicalJson(previous.window) !== canonicalJson(plan.window)) refuse("backfill_conflict");
    }
    const live = current(target, plan);
    const input = groundedWorldInput(db, [{ ...live.event, text: live.event.text.slice(plan.window.start_utf16, plan.window.end_utf16) }], plan.budget).input;
    if (planModelExtractionV2(input, plan.budget.input_token_overhead).status !== "ready") refuse("budget_exhausted");
    const day = budgetDay(new Date().toISOString());
    if (readDailyBudget(db, day, "model_calls_per_day") >= live.config.max_calls_per_day ||
        readDailyBudget(db, day, "model_output_tokens_per_day") + plan.budget.max_output_tokens > live.config.max_output_tokens_per_day) refuse("budget_exhausted");
    const reserved = db.query("INSERT INTO source_backfill_attempts VALUES(?,?,?,?,?,?,?,?,?,?)").run(plan.operation_id, plan.event_id, plan.producer_fingerprint, plan.model_binding_digest, plan.window.start_utf16,
      plan.window.end_utf16, plan.window.cap_utf16, planHash, planBytes, new Date().toISOString());
    if (reserved.changes !== 1) refuse("backfill_conflict");
    addDailyBudget(db, day, "model_calls_per_day", 1);
    return { ...live, input };
  });
  if (prior !== undefined) return prior;
  if (initial === null) refuse("backfill_conflict");
  const produced = await invokeProducerV2(producer, initial.input);
  const base = { schema: "kizuki.source-prefix-backfill-result/v1" as const, operation_id: plan.operation_id,
    plan_sha256: planHash, usage: produced.usage_known ? produced.result.usage : null, usage_known: produced.usage_known,
    claims_added: [] as string[], supports_added: 0, carried_forward: 0,
    response_sha256: produced.result.status === "ok" ? sha256Hex(canonicalJson(produced.result.response)) : null };
  let result: SourceBackfillResult;
  try {
    const answer = produced.result;
    if (!produced.usage_known || answer.status !== "ok" || answer.usage.calls !== 1 ||
        answer.usage.input_tokens > plan.budget.max_input_tokens || answer.usage.output_tokens > plan.budget.max_output_tokens || (answer.dropped?.length ?? 0) !== 0) refuse("admission_refused");
    const live = locked(target, () => current(target, plan));
    const mapped = journalWorldDrafts(db, { previous_cursor: null, cursor: null, drafts: [],
      mined: { status: "ok", count: answer.response.claims.length },
      segment: { event_id: plan.event_id, start: plan.window.start_utf16, end: plan.window.end_utf16, chars: live.event.text.length },
      world: { input: initial.input, response: answer.response } }, [live.event], producer.model_ref, producer);
    if (mapped.dropped.length !== 0) refuse("admission_refused");
    const ready: { prepared: PreparedClaimInsert; key: string }[] = [];
    const carriedReady: PreparedClaimInsert[] = [];
    let carried = 0;
    const seen = new Set<string>();
    for (const draft of mapped.drafts) {
      const key = semanticKey(draft.semantic);
      if (live.old.semantics.some(s => {
        const old = JSON.parse(String(s.payload));
        return old.discriminator === "assertion" && old.polarity !== draft.semantic.polarity &&
          semanticKey({ ...draft.semantic, polarity: old.polarity }) === s.semantic_key;
      })) refuse("admission_refused");
      const existing = db.query<{ claim_id: string }, [string]>("SELECT claim_id FROM claim_v2_semantics WHERE semantic_key=?").get(key);
      if (existing !== null && !live.old.claims.some(c => c.claim_id === existing.claim_id)) refuse("admission_refused");
      const prepared = await prepareClaimInsert({ db, vault_path: target.vault_path }, draft);
      // Re-reading the same fact is not new corroboration, even with different
      // rendering/anchors. This narrow additive operation only inserts NEW meanings.
      if (live.old.semantics.some(s => s.semantic_key === key) || seen.has(key)) { carriedReady.push(prepared); carried++; continue; }
      seen.add(key);
      ready.push({ prepared, key });
    }
    result = locked(target, () => {
      current(target, plan);
      for (const prepared of carriedReady) prepared.validate();
      const beforeSupports = Number(db.query<{ n: number }, []>("SELECT count(*) n FROM claim_v2_support").get()!.n);
      const added: string[] = [];
      for (const { prepared, key } of ready) {
        // A concurrent or unrelated parent is outside the reviewed inventory.
        // Never enter normal corroboration/duplicate support renewal for it.
        if (db.query("SELECT 1 FROM claim_v2_semantics WHERE semantic_key=?").get(key)) refuse("admission_refused");
        const inserted = prepared.apply();
        if (inserted.outcome === "stored") added.push(inserted.claim.claim_id);
        else refuse("admission_refused");
      }
      // Never mutate even metadata/confidence on an existing row as a side effect of backfill.
      for (const old of live.old.claims) {
        if (canonicalJson(db.query("SELECT * FROM claims WHERE claim_id=?").get(String(old.claim_id))) !== canonicalJson(old)) refuse("inventory_changed");
      }
      for (const [table, key, rows] of [
        ["claim_v2_semantics", "claim_id", live.old.semantics],
        ["claim_v2_support", "support_key", live.old.supports],
        ["world_observations", "observation_id", live.old.observations],
      ] as const) for (const row of rows) {
        if (canonicalJson(db.query(`SELECT * FROM ${table} WHERE ${key}=?`).get(String(row[key]))) !== canonicalJson(row)) refuse("inventory_changed");
      }
      for (const [table, rows, keys] of [
        ["claim_v2_support_events", live.old.support_events, ["support_key", "event_id"]],
        ["world_observation_events", live.old.observation_events, ["observation_id", "event_id"]],
      ] as const) for (const row of rows) {
        if (canonicalJson(db.query(`SELECT * FROM ${table} WHERE ${keys[0]}=? AND ${keys[1]}=?`).get(String(row[keys[0]]), String(row[keys[1]]))) !== canonicalJson(row)) refuse("inventory_changed");
      }
      if (sha256Hex(canonicalJson(state(db, plan.event_id))) !== plan.state_sha256) refuse("state_changed");
      const settled: SourceBackfillResult = { ...base, outcome: "settled", claims_added: added,
        supports_added: Number(db.query<{ n: number }, []>("SELECT count(*) n FROM claim_v2_support").get()!.n) - beforeSupports,
        carried_forward: carried, reason: null };
      if (db.query("INSERT INTO source_backfill_results VALUES(?,?,?,?)").run(plan.operation_id, settled.outcome, canonicalJson(settled), new Date().toISOString()).changes !== 1) refuse("admission_refused");
      addDailyBudget(db, budgetDay(new Date().toISOString()), "model_output_tokens_per_day", answer.usage.output_tokens);
      return settled;
    });
  } catch (error) {
    result = { ...base, outcome: "rejected", reason: error instanceof SourceBackfillError ? error.code : "admission_refused" };
    try { locked(target, () => {
      // Supported erasure may already have removed the event and its attempt.
      if (db.query("SELECT 1 FROM source_backfill_attempts WHERE operation_id=?").get(plan.operation_id) &&
          db.query("INSERT INTO source_backfill_results VALUES(?,?,?,?)").run(plan.operation_id, result.outcome, canonicalJson(result), new Date().toISOString()).changes !== 1) refuse("admission_refused");
      addDailyBudget(db, budgetDay(new Date().toISOString()), "model_output_tokens_per_day",
        produced.usage_known ? produced.result.usage.output_tokens : plan.budget.max_output_tokens);
    }); } catch {
      // The reservation remains unresolved and cannot be retried. Preserve the
      // actual model accounting in the returned failure; never claim settlement.
      result = { ...base, outcome: "failed", reason: "terminal_unavailable" };
    }
  }
  return result;
}
