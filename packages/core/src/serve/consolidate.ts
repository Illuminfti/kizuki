import { setImmediate as yieldToHost } from "node:timers/promises";
import { OWNER } from "../agents";
import type { LlmResponse } from "../contracts/llm";
import { consolidationConfig, parseConsolidationResponse, type ConsolidationOutcome, type ConsolidationRunReport } from "../contracts/consolidation";
import { activeWorldRegistry } from "../contracts/world-vocabulary";
import { sourceEventsAllowed, sourcePortBindingDigest } from "../ledger/source-grants";
import { classifyLlmError } from "../producer/model";
import { sha256Hex } from "../util/hash";
import { scanMatches } from "../world/pipeline/collect";
import { newReadFrame } from "../world/pipeline/frame";
import { collectConsolidationBasis, type ConsolidationBasis } from "../world/consolidation/basis";
import { consolidationPrompt } from "../world/consolidation/prompt";
import { addDailyBudget, budgetDay, readDailyBudget } from "./budget-ledger";
import type { WorldJob, WorldJobContext } from "./world-jobs";

export const CONSOLIDATION_CALLS = "consolidation_calls_per_day";
export const CONSOLIDATION_OBSERVED_OUTPUT = "consolidation_observed_output_tokens";
export const CONSOLIDATION_OUTPUT = "consolidation_output_tokens_per_day";
export const CONSOLIDATION_BUDGET_DAY = "consolidation:budget_day";
/** Each result expires on its own age, not an LRU affected by hidden evidence.
 * Admission caps (at most 512/day) times this TTL bound retained basis variants. */
export const CONSOLIDATION_RETENTION_MS = 7 * 86_400_000;
const BACKOFF_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;
type Cursor = { kind: number; after: string | null };
function clock(ctx: WorldJobContext): { at: string; ms: number } {
  const at = ctx.now(), ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error("invalid consolidation clock");
  return { at: new Date(ms).toISOString(), ms };
}
function frame(ctx: WorldJobContext) {
  return newReadFrame({ db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER }, { id: "consolidation-internal", principalId: "owner" }, { kind: "all" });
}
function cursorOf(ctx: WorldJobContext): Cursor {
  const raw = ctx.db.query<{ cursor: string | null }, []>("SELECT cursor FROM world_consolidation_jobs WHERE job_key='cursor'").get()?.cursor;
  try {
    const parsed = JSON.parse(raw ?? "null");
    if (parsed !== null && Number.isSafeInteger(parsed.kind) && parsed.kind >= 0 && (parsed.after === null || typeof parsed.after === "string")) return parsed;
  } catch { /* Corrupt disposable cursor restarts bounded discovery. */ }
  return { kind: 0, after: null };
}
function saveCursor(ctx: WorldJobContext, cursor: Cursor, outcome: string | null = null): void {
  ctx.db.query(`INSERT INTO world_consolidation_jobs(job_key,cursor,outcome,updated_at) VALUES ('cursor',?,?,?)
    ON CONFLICT(job_key) DO UPDATE SET cursor=excluded.cursor,outcome=excluded.outcome,updated_at=excluded.updated_at`)
    .run(JSON.stringify(cursor), outcome, clock(ctx).at);
}
function allowed(ctx: WorldJobContext, basis: ConsolidationBasis): boolean {
  return ctx.llm !== undefined && sourcePortBindingDigest(ctx.llm) !== sourcePortBindingDigest(undefined) &&
    sourceEventsAllowed(ctx.db, basis.eventIds, { owner: true, purpose: "derive" }) &&
    sourceEventsAllowed(ctx.db, basis.eventIds, { owner: true, model: true, purpose: "extract", port: ctx.llm });
}
function current(ctx: WorldJobContext, prior: ConsolidationBasis): ConsolidationBasis | null {
  const basis = collectConsolidationBasis(frame(ctx), prior.anchor, prior.kind);
  return basis?.digest === prior.digest && allowed(ctx, basis) ? basis : null;
}
function ready(ctx: WorldJobContext, basis: ConsolidationBasis): boolean {
  const now = clock(ctx).at;
  if (ctx.db.query("SELECT 1 FROM world_consolidation WHERE basis_digest=? AND status='complete' AND expires_at>?").get(basis.digest, now) !== null) return false;
  const waiting = ctx.db.query<{ next_at: string | null }, [string]>("SELECT next_at FROM world_consolidation_jobs WHERE basis_digest=?").get(basis.digest);
  return waiting?.next_at == null || waiting.next_at <= now;
}
/** Durable admission before network egress. Failed requests consume their reservation. */
function reserve(ctx: WorldJobContext, basis: ConsolidationBasis, nonce: string): { status: "ready"; day: string; output: number } | { status: "changed" | "budget" | "waiting" } {
  const config = consolidationConfig(ctx.consolidation), now = clock(ctx), day = budgetDay(now.at);
  return ctx.db.transaction(() => {
    if (current(ctx, basis) === null) return { status: "changed" as const };
    if (!ready(ctx, basis)) return { status: "waiting" as const };
    if (readDailyBudget(ctx.db, day, CONSOLIDATION_CALLS) >= config.max_calls_per_day ||
        readDailyBudget(ctx.db, day, CONSOLIDATION_OUTPUT) + config.max_output_tokens > config.max_output_tokens_per_day) return { status: "budget" as const };
    addDailyBudget(ctx.db, day, CONSOLIDATION_CALLS, 1);
    addDailyBudget(ctx.db, day, CONSOLIDATION_OUTPUT, config.max_output_tokens);
    ctx.db.query(`INSERT OR IGNORE INTO world_consolidation(basis_digest,handle_id,kind,members,status,created_at,expires_at)
      VALUES (?,?,?,?,'pending',?,?)`).run(basis.digest, basis.anchor, basis.kind, JSON.stringify(basis.members), now.at, new Date(now.ms + CONSOLIDATION_RETENTION_MS).toISOString());
    const insert = ctx.db.query("INSERT OR IGNORE INTO world_consolidation_basis(basis_digest,support_key,claim_id,source_key) VALUES (?,?,?,?)");
    for (const item of basis.items) for (const support of item.supports) insert.run(basis.digest, support.row.support_key, item.claimId, support.row.source_key);
    ctx.db.query(`INSERT INTO world_consolidation_jobs(job_key,basis_digest,nonce,attempts,next_at,outcome,updated_at) VALUES (?,?,?,1,?,'running',?)
      ON CONFLICT(job_key) DO UPDATE SET nonce=excluded.nonce,attempts=attempts+1,next_at=excluded.next_at,outcome='running',updated_at=excluded.updated_at`)
      .run(basis.digest, basis.digest, nonce, new Date(now.ms + config.max_pass_seconds * 1_000 + BACKOFF_MS).toISOString(), now.at);
    return { status: "ready" as const, day, output: config.max_output_tokens };
  }).immediate();
}
async function request(ctx: WorldJobContext, prompt: ReturnType<typeof consolidationPrompt>, deadlineMs: number): Promise<{ outcome: ConsolidationOutcome; response?: LlmResponse }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, watcher: ReturnType<typeof setInterval> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => { controller.abort(); reject(new Error("consolidation request interrupted")); };
    timer = setTimeout(stop, deadlineMs);
    watcher = setInterval(() => { if (ctx.stopRequested()) stop(); }, 100);
  });
  try {
    const config = consolidationConfig(ctx.consolidation);
    const response = await Promise.race([ctx.llm!.complete({ messages: prompt.messages, max_output_tokens: config.max_output_tokens,
      deadline_ms: deadlineMs, signal: controller.signal }), aborted]);
    if (!response || typeof response.text !== "string" || typeof response.model !== "string" ||
        !Number.isSafeInteger(response.usage?.input_tokens) || response.usage.input_tokens < 0 ||
        !Number.isSafeInteger(response.usage?.output_tokens) || response.usage.output_tokens < 0) return { outcome: { status: "rejected" } };
    if (response.usage.output_tokens > config.max_output_tokens) return { outcome: { status: "truncated" }, response };
    return { outcome: parseConsolidationResponse(response.text, prompt.nonce), response };
  } catch (error) {
    if (controller.signal.aborted) return { outcome: { status: ctx.stopRequested() ? "cancelled" : "unavailable" } };
    const failure = classifyLlmError(error);
    return { outcome: { status: failure.kind === "unavailable" ? "unavailable"
      : failure.diagnostic?.rule === "response_truncated" ? "truncated"
      : failure.diagnostic?.rule === "response_incomplete" ? "partial" : "rejected" } };
  } finally { clearTimeout(timer); clearInterval(watcher); }
}
function finish(ctx: WorldJobContext, basis: ConsolidationBasis, nonce: string, binding: string, result: Awaited<ReturnType<typeof request>>): boolean {
  const now = clock(ctx);
  return ctx.db.transaction(() => {
    const attempt = ctx.db.query<{ attempts: number }, [string, string]>("SELECT attempts FROM world_consolidation_jobs WHERE basis_digest=? AND nonce=? AND outcome='running'").get(basis.digest, nonce);
    // Erasure, another attempt or a rebuilt derived layer wins permanently.
    if (attempt === null) return false;
    if (sourcePortBindingDigest(ctx.llm) !== binding || current(ctx, basis) === null) {
      ctx.db.query("DELETE FROM world_consolidation WHERE basis_digest=?").run(basis.digest); return false;
    }
    if (result.outcome.status === "complete" && result.response !== undefined && !ctx.stopRequested()) {
      ctx.db.query(`UPDATE world_consolidation SET status='complete',summary=?,completed_at=?,model_ref_hash=?,response_hash=?,input_tokens=?,output_tokens=? WHERE basis_digest=?`)
        .run(result.outcome.summary, now.at, sha256Hex(ctx.llm!.model_ref ?? "unidentified"), sha256Hex(result.response.text), result.response.usage.input_tokens, result.response.usage.output_tokens, basis.digest);
      ctx.db.query("UPDATE world_consolidation_jobs SET nonce=NULL,next_at=NULL,outcome='complete',updated_at=? WHERE basis_digest=?").run(now.at, basis.digest);
      return true;
    } else {
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** Math.min(10, attempt.attempts - 1));
      ctx.db.query("UPDATE world_consolidation_jobs SET nonce=NULL,next_at=?,outcome=?,updated_at=? WHERE basis_digest=?")
        .run(new Date(now.ms + delay).toISOString(), ctx.stopRequested() ? "cancelled" : result.outcome.status, now.at, basis.digest);
      return false;
    }
  }).immediate();
}
export const consolidationJob: WorldJob = { id: "consolidation", async run(ctx) {
  const report: { -readonly [K in keyof ConsolidationRunReport]: ConsolidationRunReport[K] } = {
    handles: 0, calls: 0, completed: 0, input_tokens: 0, output_tokens: 0, output_tokens_charged: 0, usage_unknown: false, outcomes: {},
  };
  const outcomes: Partial<Record<(typeof import("../contracts/consolidation").CONSOLIDATION_OUTCOMES)[number], number>> = {};
  report.outcomes = outcomes;
  try {
    const config = consolidationConfig(ctx.consolidation), start = performance.now();
    const now = clock(ctx);
    ctx.db.query("DELETE FROM world_consolidation WHERE expires_at<=?").run(now.at);
    if (!ctx.modelConfigured || ctx.llm === undefined || config.max_calls_per_pass === 0) return;
    const kinds = activeWorldRegistry().kinds, cursor = cursorOf(ctx);
    cursor.kind %= kinds.length;
    let handles = 0, calls = 0, kindsVisited = 0, steps = 0;
    while (handles < config.max_handles_per_pass && steps < config.max_handles_per_pass + kinds.length && kindsVisited < kinds.length) {
      if (ctx.stopRequested() || performance.now() - start >= config.max_pass_seconds * 1_000) return;
      const kind = kinds[cursor.kind]!;
      steps += 1;
      // Empty kinds have their own finite step allowance; the configured handle
      // budget still permits one candidate even when earlier kinds are empty.
      // One independently bounded discovery frame per step: many large but valid
      // records cannot collectively exhaust a shared projection byte allowance.
      const scan = scanMatches(frame(ctx), kind, "", cursor.after, 1);
      for (const candidate of scan.found) {
        if (ctx.stopRequested() || performance.now() - start >= config.max_pass_seconds * 1_000 || calls >= config.max_calls_per_pass) return;
        handles += 1; report.handles = handles;
        const work = frame(ctx), basis = collectConsolidationBasis(work, candidate.handle, kind.id);
        // Consent is checked before building a prompt or reading lineage text.
        if (basis !== null && allowed(ctx, basis) && ready(ctx, basis)) {
          const prompt = consolidationPrompt(work, basis);
          if (prompt.inputTokens <= config.max_input_tokens) {
            const reservation = reserve(ctx, basis, prompt.nonce);
            if (reservation.status === "budget") { saveCursor(ctx, cursor, CONSOLIDATION_BUDGET_DAY); return { stop: CONSOLIDATION_BUDGET_DAY }; }
            if (reservation.status === "ready") {
              calls += 1; report.calls = calls; report.output_tokens_charged += reservation.output;
              const binding = sourcePortBindingDigest(ctx.llm);
              const remaining = Math.max(1, Math.floor(config.max_pass_seconds * 1_000 - (performance.now() - start)));
              const result = await request(ctx, prompt, remaining);
              // A transport that exceeds its declared cap cannot hide observed
              // consumption, including when source erasure deleted the attempt.
              const excess = (result.response?.usage.output_tokens ?? 0) - reservation.output;
              if (result.response === undefined) report.usage_unknown = true;
              else {
                report.input_tokens += result.response.usage.input_tokens; report.output_tokens += result.response.usage.output_tokens;
                report.output_tokens_charged += Math.max(0, excess);
                ctx.db.transaction(() => {
                  addDailyBudget(ctx.db, reservation.day, CONSOLIDATION_OBSERVED_OUTPUT, result.response!.usage.output_tokens);
                  if (excess > 0) addDailyBudget(ctx.db, reservation.day, CONSOLIDATION_OUTPUT, excess);
                }).immediate();
              }
              const completed = finish(ctx, basis, prompt.nonce, binding, result);
              if (completed) report.completed += 1;
              const outcome = result.outcome.status === "complete" && !completed ? "discarded" : result.outcome.status;
              outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
            }
          }
        }
        cursor.after = candidate.handle; saveCursor(ctx, cursor);
        await yieldToHost();
      }
      if (scan.resumeAfter !== null) { cursor.after = scan.resumeAfter; saveCursor(ctx, cursor); continue; }
      cursor.kind = (cursor.kind + 1) % kinds.length; cursor.after = null; kindsVisited += 1; saveCursor(ctx, cursor);
    }
  } finally { ctx.onConsolidation?.(report); }
} };
