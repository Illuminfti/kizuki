/** Reflex is a read-only assessment of selected evidence, never an execution permit. */
export const REFLEX_POLICY = "kizuki.reflex.atomic/v1" as const;
export const REFLEX_LIMITS = Object.freeze({
  assumptions: 8, events: 16, statement_bytes: 512, evidence_bytes: 4_096,
  state_bytes: 24_576, events_per_batch: 4, concurrency: 2,
  default_age_ms: 7 * 86_400_000, max_age_ms: 365 * 86_400_000,
  default_timeout_ms: 10_000, max_timeout_ms: 30_000, ttl_ms: 60_000,
  min_confidence: 0.8, min_probability: 0.8,
});
export interface ReflexAssumption {
  readonly id: string;
  readonly statement: string;
  readonly importance: "critical" | "normal";
}
export interface ReflexRequest {
  readonly assumptions: readonly ReflexAssumption[];
  /** Current, bare ledger event IDs obtained through an authorized read. */
  readonly event_ids: readonly string[];
  readonly max_age_ms?: number;
}
export type ReflexRelation = "supports" | "contradicts" | "irrelevant" | "unclear";
export type ReflexVerdict = "supported" | "contradicted" | "conflicted" | "unknown";
export interface ReflexEvidence {
  readonly event_id: string;
  readonly occurred_at: string;
  readonly sensitivity: "public" | "personal" | "private";
  readonly sha256: string | null;
  readonly eligibility: "eligible" | "stale" | "future" | "oversized" | "model_egress_denied";
}
export interface ReflexCell {
  readonly assumption_id: string;
  readonly event_id: string;
  readonly relation: ReflexRelation;
  readonly confidence: number;
  readonly probability: number;
}
export interface ReflexFinding extends ReflexAssumption {
  readonly verdict: ReflexVerdict;
  readonly supporting: readonly string[];
  readonly contradicting: readonly string[];
  readonly unresolved: readonly string[];
  /** Deterministic guidance, not generated prose or a command to execute. */
  readonly next_step: string;
}
export type ReflexFailure = "not_configured" | "no_eligible_evidence" | "model_unavailable" | "invalid_response" | "timeout" | "busy" | "invalidated" | "request_too_large";
export interface ReflexMetrics {
  readonly dispatched_batches: number;
  readonly questions: number;
  /** Provider-reported counts; not a price estimate or accuracy measurement. */
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly elapsed_ms: number;
}
export interface ReflexReport {
  readonly schema: "kizuki.reflex/v1";
  readonly policy: typeof REFLEX_POLICY;
  readonly status: "assessed" | "unavailable";
  readonly reason: ReflexFailure | null;
  readonly authority: "advisory_only";
  readonly requires_revalidation: true;
  readonly snapshot: {
    readonly at: string;
    /** Upper bound only: revocation or evidence changes invalidate it sooner. */
    readonly valid_until: string;
    readonly principal: string;
    readonly source_epoch: number;
    readonly claims_epoch: number;
    readonly digest: string;
    readonly model_binding: string;
  };
  readonly coverage: {
    readonly requested_events: number;
    readonly readable_events: number;
    readonly examined_events: number;
    readonly exhaustive: false;
  };
  readonly model: string | null;
  readonly evidence: readonly ReflexEvidence[];
  readonly matrix: readonly ReflexCell[];
  /** Ordered by unresolved risk, with critical assumptions first within each verdict. */
  readonly findings: readonly ReflexFinding[];
  readonly metrics: ReflexMetrics;
}
