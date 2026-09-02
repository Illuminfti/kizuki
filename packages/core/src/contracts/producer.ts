import type { Sensitivity } from "../agents/types";
import type { SubjectRef } from "./event";
import type { Port } from "./ports";

export const PRODUCER_CONTRACT = "kizuki.producer/v1" as const;
export const PRODUCER_CONTRACT_MINOR = 1;
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

export type ProduceResult =
  | {
      status: "ok";
      claims: ClaimDraft[];
      usage: ModelUsage;
      /**
       * The input events this result accounts for. A run that stopped early —
       * a spent budget, a refused answer, a model that did not reply — covers
       * a prefix of the input, and a caller advances its checkpoint over
       * these events and no further. `contract_minor >= 1`.
       */
      covered_event_ids: string[];
      /**
       * Registry-shaped predicates a draft named that the registry does not
       * hold, so the registry can grow deliberately rather than drift
       * (RFC 0002 §4.2). `contract_minor >= 1`.
       */
      dropped_predicates: string[];
    }
  | { status: "unavailable"; reason: string }
  | {
      status: "rejected";
      reason: RejectReason;
      usage: ModelUsage;
    };

export interface ProducerPort extends Port {
  produce(input: ProduceInput): Promise<ProduceResult>;
}
