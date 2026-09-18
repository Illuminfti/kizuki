import { DependencyGraph } from "./graph";
import { questionRequest, readJudgment, unknownJudgment, type ReflexHost } from "./systemone";
import { REFLEX_SCHEMA, type Change, type Failure, type Judgment, type Limits, type ReflexReport, type Snapshot, type Thresholds } from "./types";
import { deepFreeze, limits, ReflexError, thresholds, validatedInput } from "./validate";

export interface AnalyzeOptions {
  readonly host?: ReflexHost;
  readonly limits?: Partial<Limits>;
  readonly thresholds?: Partial<Thresholds>;
}
/** A timed-out provider may still be running. Stop scheduling, do not refill its slot. */
async function bounded<T>(operation: () => Promise<T>, timeout: number): Promise<T> {
  if (timeout <= 0) throw new ReflexError("deadline_exceeded");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReflexError("deadline_exceeded")), timeout);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Read-only analysis of ONE bounded, host-authorized snapshot and ONE change.
 * No files, network client, mutation, cache, agent spawning or ambient secrets.
 */
export async function analyzeChange(rawSnapshot: Snapshot, rawChange: Change, options: AnalyzeOptions = {}): Promise<ReflexReport> {
  const start = performance.now();
  const { snapshot, change } = validatedInput(rawSnapshot, rawChange);
  const budget = limits(options.limits);
  const policy = thresholds(options.thresholds);
  const host = options.host;
  const graph = new DependencyGraph(snapshot);
  const end = start + budget.total_timeout_ms;
  const judgments: Array<Judgment | undefined> = new Array(change.target_ids.length);
  const metrics = { candidates: change.target_ids.length, requests_started: 0, questions_started: 0,
    max_in_flight: 0, request_bytes: 0, input_tokens: 0, output_tokens: 0, usage_complete: true, elapsed_ms: 0 };
  let inFlight = 0;
  let cursor = 0;
  let stopped: Failure | undefined;
  let stale = Date.parse(snapshot.binding.expires_at) <= Date.now();
  const remaining = () => Math.max(0, Math.min(budget.request_timeout_ms, end - performance.now()));
  const current = async () => {
    if (Date.parse(snapshot.binding.expires_at) <= Date.now()) return false;
    return host !== undefined && await bounded(() => host.isCurrent(snapshot.binding), remaining()) === true;
  };
  if (stale) stopped = "stale_snapshot";
  else if (host === undefined) stopped = "not_configured";
  else {
    try {
      if (!await current()) { stale = true; stopped = "stale_snapshot"; }
    } catch (error) {
      stopped = error instanceof ReflexError ? error.code : "host_unavailable";
    }
  }
  const run = async () => {
    while (stopped === undefined) {
      const index = cursor++;
      if (index >= change.target_ids.length) return;
      const target = change.target_ids[index]!;
      const node = graph.nodes.get(target)!;
      try {
        // Authorization epochs can change while another candidate is evaluated.
        if (!await current()) { stale = true; stopped = "stale_snapshot"; return; }
        if (stopped !== undefined) return;
        if (performance.now() >= end) { stopped = "deadline_exceeded"; return; }
        if (metrics.requests_started >= budget.max_requests) {
          judgments[index] = unknownJudgment(target, "budget_exhausted");
          continue;
        }
        const request = questionRequest(node, change, Math.max(1, Math.floor(remaining())));
        const bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
        if (bytes > budget.max_request_bytes || metrics.request_bytes + bytes > budget.max_total_request_bytes) {
          judgments[index] = unknownJudgment(target, "budget_exhausted");
          continue;
        }
        // Reservation is synchronous: concurrent workers cannot overbook the budget.
        metrics.requests_started += 1;
        metrics.questions_started += Object.keys(request.questions).length;
        metrics.request_bytes += bytes;
        inFlight += 1;
        metrics.max_in_flight = Math.max(metrics.max_in_flight, inFlight);
        const scope = deepFreeze({ binding: snapshot.binding, target_id: target, target_revision: node.revision,
          change_id: change.id, evidence_ids: [...new Set([...node.evidence_ids, ...change.evidence_ids])].sort() });
        try {
          const response = await bounded(() => host!.evaluateAuthorized(request, scope), remaining());
          const result = readJudgment(response, target, policy);
          judgments[index] = result.judgment;
          if (result.judgment.reason === "invalid_response") metrics.usage_complete = false;
          metrics.input_tokens += result.input_tokens;
          metrics.output_tokens += result.output_tokens;
        } catch (error) {
          metrics.usage_complete = false;
          throw error;
        } finally {
          inFlight -= 1;
        }
      } catch (error) {
        const reason: Failure = error instanceof ReflexError ? error.code : "host_unavailable";
        judgments[index] = unknownJudgment(target, reason);
        // Do not accumulate abandoned requests when an adapter ignores its deadline.
        if (reason === "deadline_exceeded") stopped = reason;
        if (reason === "stale_snapshot") { stale = true; stopped = reason; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(budget.concurrency, change.target_ids.length) }, run));
  if (host !== undefined && stopped !== "not_configured" && !stale) {
    try {
      if (!await current()) { stale = true; stopped = "stale_snapshot"; }
    } catch (error) {
      stopped = error instanceof ReflexError ? error.code : "host_unavailable";
    }
  }
  // Never retain a positive/negative conclusion after freshness could not be checked.
  const invalidateAll = stale || stopped === "host_unavailable" || stopped === "deadline_exceeded";
  const results = change.target_ids.map((target, index) => invalidateAll
    ? unknownJudgment(target, stale ? "stale_snapshot" : stopped!)
    : judgments[index] ?? unknownJudgment(target, stopped ?? "budget_exhausted"));
  const impacts = graph.impacts(results);
  metrics.elapsed_ms = Math.round((performance.now() - start) * 100) / 100;
  return deepFreeze({ schema: REFLEX_SCHEMA, advisory_only: true, mode: "observed", authorizes_execution: false,
    binding: snapshot.binding, change_id: change.id,
    status: stale ? "stale" : results.some((j) => j.effect === "unknown") ? "incomplete" : "complete",
    analyzed_revisions: snapshot.nodes.map((n) => ({ node_id: n.id, revision: n.revision })),
    judgments: results, impacts, metrics });
}
