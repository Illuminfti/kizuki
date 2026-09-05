import type { Sensitivity } from "../agents/types";
import type { SubjectRef } from "./event";
import type { Port } from "./ports";

export const PRODUCER_CONTRACT = "kizuki.producer/v1" as const;
/** Minor 2 adds an optional content-free diagnostic to failed results. */
export const PRODUCER_CONTRACT_MINOR = 2;
export const PRODUCER_CAPABILITIES = ["deterministic", "model"] as const;
export type ProducerCapability =
  (typeof PRODUCER_CAPABILITIES)[number];

export interface QuotedEvent {
  readonly event_id: string;
  readonly connector_id: string;
  readonly occurred_at: string;
  readonly observed_at: string;
  readonly text: string;
  readonly subjects: readonly SubjectRef[];
  readonly taint: "untrusted" | "owner";
}

export interface ClaimSummary {
  readonly claim_id: string;
  readonly subject: string | null;
  readonly predicate: string | null;
  readonly object: string | null;
  readonly polarity: "positive" | "negative";
  readonly confidence: number;
}

export interface ProduceInput {
  readonly events: readonly QuotedEvent[];
  readonly context: {
    readonly subjects: readonly SubjectRef[];
    readonly known_claims: readonly ClaimSummary[];
    readonly predicates: readonly string[];
  };
  readonly budget: {
    readonly max_calls: number;
    readonly max_input_tokens: number;
    readonly max_output_tokens: number;
  };
}

export interface ModelUsage {
  readonly calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export type DiagnosticShape = "undefined" | "null" | "array" | "object" | "string" | "number" | "boolean" | "other";
export interface ClaimDiagnostic {
  readonly stage: "claims";
  readonly rule: "text" | "size_cap" | "json" | "object" | "missing_field" | "extra_field" | "list" | "list_cap" | "bounded_string" | "enum" | "timestamp" | "confidence" | "event_ids" | "verbatim";
  readonly field: "response" | "claims" | "claim" | "kind" | "subject" | "predicate" | "object" | "polarity" | "body" | "valid_from" | "valid_to" | "confidence" | "sensitivity" | "event_ids";
  readonly shape: DiagnosticShape;
  readonly claim_index: number | null;
  readonly claim_count: number | null;
}

/** Fixed vocabulary and numeric structure only; never provider or captured text. */
export type ProducerDiagnostic =
  | ClaimDiagnostic
  | { readonly stage: "response"; readonly rule: "tool_call" | "bad_response" | "unsupported_metadata" | "response_refused" | "response_truncated" | "response_incomplete" | "response_too_large" }
  | { readonly stage: "transport"; readonly rule: "timeout" | "network" | "redirect" | "credentials" | "http" | "unavailable"; readonly http_status?: number }
  | { readonly stage: "budget"; readonly rule: "max_calls" | "max_input_tokens" | "max_output_tokens"; readonly used: number; readonly requested: number; readonly limit: number };

export const PRODUCER_REJECT_REASONS = [
  "tool_call_in_response",
  "fence_leak",
  "schema_invalid",
  "unknown_predicate",
  "provenance_not_cited",
  "budget_exhausted",
] as const;
export type RejectReason =
  (typeof PRODUCER_REJECT_REASONS)[number];

export type ClaimDraftKind =
  | "entity"
  | "claim"
  | "edit"
  | "merge"
  | "deletion";

export interface ClaimDraft {
  readonly kind: ClaimDraftKind;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly polarity: "positive" | "negative";
  readonly body: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly confidence: number;
  readonly sensitivity: Sensitivity;
  readonly event_ids: readonly string[];
}

export interface ExtractResponse {
  readonly claims: readonly ClaimDraft[];
}

export const DROPPED_DRAFT_REASONS = [
  "unknown_predicate",
  "unknown_subject",
  "event_too_large",
] as const;
export type DroppedDraftReason = (typeof DROPPED_DRAFT_REASONS)[number];

/**
 * A draft or record the producer declined without failing the call. Recorded
 * so the run receipt can count it and the predicate registry can grow
 * deliberately (RFC 0002 §4.2). Never carries captured text.
 */
export type DroppedDraft =
  | {
      readonly reason: "unknown_predicate";
      readonly predicate: string;
      readonly event_ids: readonly string[];
    }
  | {
      readonly reason: "unknown_subject";
      readonly subject: string;
      readonly event_ids: readonly string[];
    }
  | {
      readonly reason: "event_too_large";
      readonly event_id: string;
      readonly chars: number;
    };

export type ProduceResult =
  | {
      status: "ok";
      claims: ClaimDraft[];
      usage: ModelUsage;
      dropped?: DroppedDraft[];
    }
  | { status: "unavailable"; reason: string; usage: ModelUsage; diagnostic?: ProducerDiagnostic }
  | {
      status: "rejected";
      reason: RejectReason;
      usage: ModelUsage;
      diagnostic?: ProducerDiagnostic;
    };

export interface ProducerPort extends Port {
  produce(input: ProduceInput): Promise<ProduceResult>;
}
