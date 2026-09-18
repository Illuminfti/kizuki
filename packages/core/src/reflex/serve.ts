import { createHash } from "node:crypto";
import { resolvePrincipal, toolAllowed } from "../agents";
import type { AuditDenial, AuditItem } from "../agents";
import { canonReadGeneration } from "../canon/write-intent";
import type { SystemOnePort } from "../contracts/systemone";
import { purgeReadEpoch } from "../derived-holds";
import { sourceEventsAllowed, sourcePolicyEpoch, sourcePortBindingDigest } from "../ledger/source-grants";
import { claimsEpoch } from "../serving/epoch";
import { gateAsync, principalName } from "../serving/gate";
import { currentQuotedSource, eventDecision, readServableEvents } from "../serving/ledger";
import { ServeError } from "../serving/types";
import type { ServeContext } from "../serving/types";
import { isRfc3339 } from "../util/time";
import { evaluateMatrix, reduceFindings } from "./engine";
import type { MatrixResult } from "./engine";
import { bytes, invalidInput, parseReflexRequest } from "./input";
import { REFLEX_LIMITS, REFLEX_POLICY } from "./types";
import type { ReflexEvidence, ReflexReport, ReflexRequest } from "./types";

export interface ReflexOptions {
  /** Host-selected and source-bound port. No endpoint or secret comes from agent arguments. */
  readonly systemone?: SystemOnePort;
  readonly timeout_ms?: number;
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Trusted-host API. Uses the existing context_packet read capability and audit
 * gate; does not register a new MCP tool or change context_packet's wire shape.
 * Read permission and exact-destination model consent are separate checks.
 */
export async function assessReflex(context: ServeContext, args: ReflexRequest, options: ReflexOptions = {}): Promise<ReflexReport> {
  const envelope = await gateAsync({ ...context, sourcePurpose: "recall" }, "context_packet", { reflex: args }, async ({ ctx, at }) => {
    const started = performance.now();
    const request = parseReflexRequest(args);
    const timeout = options.timeout_ms ?? REFLEX_LIMITS.default_timeout_ms;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > REFLEX_LIMITS.max_timeout_ms) invalidInput();
    const deadline = Date.now() + timeout;
    const port = options.systemone;
    const modelRef = port?.model_ref ?? null;
    const sourceEpoch = sourcePolicyEpoch(ctx.db), epoch = claimsEpoch(ctx.db);
    const purgeEpoch = purgeReadEpoch(ctx.db), canonGeneration = canonReadGeneration(ctx.db);
    const binding = sourcePortBindingDigest(port);
    const facts = readServableEvents(ctx.db, [...request.event_ids]);
    const evidence: ReflexEvidence[] = [];
    const eligible: (ReflexEvidence & { text: string })[] = [];
    const withheld: AuditDenial[] = [];
    const audit: AuditItem[] = [];
    const now = Date.parse(at);

    for (const id of request.event_ids) {
      const fact = facts.get(id);
      if (fact === undefined) continue; // Unknown and deleted IDs reveal no existence information.
      const access = eventDecision(ctx.principal.grant, fact, ctx);
      if (!access.allow) { withheld.push({ id, reason: access.reason }); continue; }
      const occurred = Date.parse(fact.occurred_at);
      // RFC3339 admits leap seconds which the host clock cannot represent.
      // Never let a NaN age bypass both freshness comparisons.
      if (!isRfc3339(fact.occurred_at) || !Number.isFinite(occurred)) { withheld.push({ id, reason: "held" }); continue; }
      const age = now - occurred;
      // Bound the body before allocating it. Never clip a negation into an apparent support.
      const size = ctx.db.query<{ bytes: number }, [string]>("SELECT length(CAST(text AS BLOB)) AS bytes FROM events WHERE event_id = ?").get(id)?.bytes;
      let eligibility: ReflexEvidence["eligibility"] = age < 0 ? "future" : age > request.max_age_ms ? "stale" : "eligible";
      if (size === undefined || !Number.isSafeInteger(size) || size < 0 || size > REFLEX_LIMITS.evidence_bytes) eligibility = "oversized";
      let text: string | null = null;
      if (eligibility !== "oversized") {
        const source = currentQuotedSource(ctx.db, id);
        if (source === null) continue;
        if (bytes(source.text) > REFLEX_LIMITS.evidence_bytes) eligibility = "oversized";
        else text = source.text;
      }
      // Unlike legacy capture, Reflex never treats the epoch-zero compatibility
      // bypass as permission to send evidence to a new model consumer.
      if (eligibility === "eligible" && port !== undefined && modelRef !== null &&
          (sourceEpoch === 0 || !sourceEventsAllowed(ctx.db, [id], { owner: ctx.principal.kind === "owner", purpose: "extract", model: true, port }))) {
        eligibility = "model_egress_denied";
      }
      const item: ReflexEvidence = { event_id: id, occurred_at: fact.occurred_at, sensitivity: access.sensitivity, sha256: text === null ? null : hash(text), eligibility };
      evidence.push(item);
      audit.push({ id, sensitivity: access.sensitivity, taint: "quoted", authority: null, provenance_count: 1 });
      if (eligibility === "eligible" && text !== null) eligible.push({ ...item, text });
    }
    const stable = (): boolean => {
      if (sourcePolicyEpoch(ctx.db) !== sourceEpoch || claimsEpoch(ctx.db) !== epoch ||
          purgeReadEpoch(ctx.db) !== purgeEpoch || canonReadGeneration(ctx.db) !== canonGeneration ||
          sourcePortBindingDigest(port) !== binding || (port?.model_ref ?? null) !== modelRef) return false;
      const current = resolvePrincipal(ctx.db, ctx.principal);
      if (current === null || current.kind !== ctx.principal.kind || !toolAllowed(current.grant, "context_packet")) return false;
      if (current.kind === "agent" && ctx.principal.kind === "agent" && current.grant_epoch !== ctx.principal.grant_epoch) return false;
      if (port === undefined || modelRef === null) return true;
      return eligible.every(item => {
        const size = ctx.db.query<{ bytes: number }, [string]>("SELECT length(CAST(text AS BLOB)) AS bytes FROM events WHERE event_id = ?").get(item.event_id)?.bytes;
        if (size === undefined || !Number.isSafeInteger(size) || size < 0 || size > REFLEX_LIMITS.evidence_bytes) return false;
        const source = currentQuotedSource(ctx.db, item.event_id);
        return source !== null && hash(source.text) === item.sha256 &&
          eventDecision(current.grant, source, { ...ctx, principal: current }).allow &&
          sourceEpoch > 0 && sourceEventsAllowed(ctx.db, [item.event_id], { owner: current.kind === "owner", purpose: "extract", model: true, port });
      });
    };
    let result: MatrixResult = {
      status: "unavailable", reason: port === undefined || modelRef === null ? "not_configured" : "no_eligible_evidence",
      model: null, cells: [], metrics: { dispatched_batches: 0, questions: 0, input_tokens: 0, output_tokens: 0, elapsed_ms: 0 },
    };
    if (port !== undefined && modelRef !== null && eligible.length > 0) {
      result = await evaluateMatrix({ assumptions: request.assumptions, evidence: eligible }, port, deadline, stable);
    }
    if (result.reason === "invalidated" || !stable()) throw new ServeError("error", "memory or authority changed during Reflex assessment; retry");
    const validUntil = Math.min(now + REFLEX_LIMITS.ttl_ms, ...eligible.map(e => Date.parse(e.occurred_at) + request.max_age_ms));
    // Model results which outlive the selected freshness window cannot certify it.
    if (result.status === "assessed" && Date.now() >= validUntil) {
      result = { ...result, status: "unavailable", reason: "invalidated", cells: [], model: null };
    }
    const report: ReflexReport = {
      schema: "kizuki.reflex/v1", policy: REFLEX_POLICY, status: result.status, reason: result.reason,
      authority: "advisory_only", requires_revalidation: true,
      snapshot: {
        at, valid_until: new Date(Math.max(now, validUntil)).toISOString(), principal: principalName(ctx.principal), source_epoch: sourceEpoch, claims_epoch: epoch,
        digest: hash(JSON.stringify([REFLEX_POLICY, at, principalName(ctx.principal), sourceEpoch, epoch, binding, request, evidence])), model_binding: binding,
      },
      coverage: { requested_events: request.event_ids.length, readable_events: evidence.length, examined_events: result.status === "assessed" ? eligible.length : 0, exhaustive: false },
      model: result.model, evidence, matrix: result.cells, findings: reduceFindings(request.assumptions, result.cells),
      metrics: { ...result.metrics, elapsed_ms: Math.ceil(performance.now() - started) },
    };
    return { canon: [], quoted: [], withheld, audit_served: audit, data: report };
  });
  if (envelope.data === undefined) throw new ServeError("error", "Reflex assessment unavailable");
  return envelope.data;
}
