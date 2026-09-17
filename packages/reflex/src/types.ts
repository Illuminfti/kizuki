/** Read-only, derived analysis. None of these objects confer authority. */
export const REFLEX_SCHEMA = "kizuki.reflex-impact/v1" as const;

export type NodeKind = "fact" | "decision" | "action";
export type Effect = "needs_revalidation" | "no_change_detected" | "unknown";
export type Failure =
  | "invalid_input" | "resource_limit" | "not_configured" | "stale_snapshot"
  | "budget_exhausted" | "deadline_exceeded" | "host_unavailable"
  | "invalid_response" | "ambiguous_evidence";

export interface SnapshotBinding {
  readonly snapshot_id: string;
  readonly principal_id: string;
  readonly policy_epoch: number;
  readonly expires_at: string;
}
export interface MemoryNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly revision: string;
  readonly statement: string;
  readonly evidence_ids: readonly string[];
  /** Host-assigned consequence, not a model estimate of money or correctness. */
  readonly consequence: 0 | 1 | 2 | 3 | 4;
}
export interface Dependency {
  readonly prerequisite: string;
  readonly dependent: string;
  readonly evidence_ids: readonly string[];
}
export interface Snapshot {
  readonly binding: SnapshotBinding;
  readonly nodes: readonly MemoryNode[];
  readonly dependencies: readonly Dependency[];
}
export interface Change {
  readonly id: string;
  readonly statement: string;
  readonly occurred_at: string;
  readonly evidence_ids: readonly string[];
  /** Candidate nomination belongs to authorized retrieval/the host, not Jev. */
  readonly target_ids: readonly string[];
}
export interface Limits {
  readonly concurrency: number;
  readonly max_requests: number;
  readonly request_timeout_ms: number;
  readonly total_timeout_ms: number;
  readonly max_request_bytes: number;
  readonly max_total_request_bytes: number;
}
export interface Thresholds {
  readonly evidence_min: number;
  readonly applicability_min: number;
  readonly relation_probability_min: number;
  readonly relation_confidence_min: number;
  readonly counterevidence_max: number;
}
export type Relation = "contradicts" | "supersedes" | "supports" | "unrelated" | "unknown";
export interface Judgment {
  readonly target_id: string;
  readonly effect: Effect;
  readonly reason: Failure | "supported_change" | "no_change_detected" | "counterfactual_assumption";
  readonly relation?: Relation;
  readonly confidence?: number;
  readonly probability?: number;
  readonly consequence?: number;
}
export interface ImpactReason {
  readonly target_id: string;
  readonly effect: "needs_revalidation" | "unknown";
  /** A shortest-path predecessor in the supplied graph, not a causal claim. */
  readonly via: string | null;
  readonly distance: number;
}
export interface Impact {
  readonly node_id: string;
  readonly kind: NodeKind;
  readonly revision: string;
  readonly effect: "needs_revalidation" | "unknown";
  readonly consequence: number;
  readonly reasons: readonly ImpactReason[];
}
export interface Metrics {
  readonly candidates: number;
  readonly requests_started: number;
  readonly questions_started: number;
  readonly max_in_flight: number;
  readonly request_bytes: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  /** False when any started evaluation failed to return validated usage. */
  readonly usage_complete: boolean;
  readonly elapsed_ms: number;
}
export interface ReflexReport {
  readonly schema: typeof REFLEX_SCHEMA;
  readonly advisory_only: true;
  readonly mode: "observed" | "counterfactual";
  /** Always false: a clean analysis is not an authorization capability. */
  readonly authorizes_execution: false;
  readonly binding: SnapshotBinding;
  readonly change_id: string;
  readonly status: "complete" | "incomplete" | "stale";
  readonly analyzed_revisions: readonly { readonly node_id: string; readonly revision: string }[];
  readonly judgments: readonly Judgment[];
  readonly impacts: readonly Impact[];
  readonly metrics: Metrics;
}
export interface PlanStep {
  readonly id: string;
  /** Every assumption declared by the external agent must name its revision. */
  readonly assumptions: readonly { readonly node_id: string; readonly revision: string }[];
}
export interface StepAdvice {
  readonly step_id: string;
  readonly status: "revalidate" | "unexamined" | "no_change_detected";
  readonly affected_ids: readonly string[];
}
export interface Trace {
  readonly nodes: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly truncated: boolean;
}
