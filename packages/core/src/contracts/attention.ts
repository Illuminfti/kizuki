import { isPlainObject } from "../util/validate";
import { cardCodec, coverage, exact, type Coverage, type WorldWireRef } from "./world-card-kit";

export const ATTENTION_SCHEMA = "kizuki.attention/v1" as const;
export const ATTENTION_SOURCES = ["blocker", "uncertainty", "commitment_due", "stale_summary"] as const;
export type AttentionSource = typeof ATTENTION_SOURCES[number];
/** Exact deterministic notification text, also used by canonical purge redaction. */
export function attentionDeliveryLine(source: AttentionSource, cue: string): string {
  return `- ${source.replaceAll("_", " ")} for an explicit objective. Inspect evidence with \`kizuki attention\`. Cue: ${cue}`;
}
export function attentionDeliveryBody(source: AttentionSource, cue: string): string {
  return `# Attention\n\n${attentionDeliveryLine(source, cue)}\n`;
}

export type AttentionCandidate = {
  readonly state: "candidate";
  readonly cue: string;
  readonly source: AttentionSource;
  readonly subject: WorldWireRef<"object">;
  readonly disposition: "none" | "dismissed" | "snoozed";
  readonly snoozedUntil: string | null;
};
export type AttentionState = AttentionCandidate
  | { readonly state: "quiet"; readonly reason: "no_material_change" }
  | { readonly state: "missing_coverage"; readonly reason: "source_unobserved" }
  | { readonly state: "stale_consolidation"; readonly reason: "summary_older_than_ledger" }
  | { readonly state: "provider_failure"; readonly reason: "model_unavailable" | "provider_error" };
export type Attention = { readonly schema: typeof ATTENTION_SCHEMA; readonly states: readonly AttentionState[]; readonly coverage: Coverage };
export const validCueKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
function state(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.state === "candidate") return exact(value, ["state", "cue", "source", "subject", "disposition", "snoozedUntil"]) &&
    validCueKey(value.cue) && ATTENTION_SOURCES.includes(value.source as AttentionSource) && isPlainObject(value.subject) &&
    exact(value.subject, ["kind", "token"]) && value.subject.kind === "object" && validCueKey(value.subject.token) &&
    ["none", "dismissed", "snoozed"].includes(String(value.disposition)) &&
    (value.disposition === "snoozed" ? instant(value.snoozedUntil) : value.snoozedUntil === null);
  if (!exact(value, ["state", "reason"])) return false;
  return value.state === "quiet" && value.reason === "no_material_change" ||
    value.state === "missing_coverage" && value.reason === "source_unobserved" ||
    value.state === "stale_consolidation" && value.reason === "summary_older_than_ledger" ||
    value.state === "provider_failure" && ["model_unavailable", "provider_error"].includes(String(value.reason));
}
export const validateAttention = cardCodec<Attention, "attention">({ schema: ATTENTION_SCHEMA, label: "attention", fields: {
  states: value => Array.isArray(value) && value.length > 0 && value.length <= 68 && value.every(state), coverage,
} });
