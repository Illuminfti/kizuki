import type { ClaimDiagnostic, DiagnosticShape, ProducerDiagnostic } from "../contracts/producer";
import { isPlainObject } from "../util/validate";

const SHAPES = new Set(["undefined", "null", "array", "object", "string", "number", "boolean", "other"]);
const FIELDS = new Set(["response", "claims", "claim", "kind", "subject", "predicate", "object", "polarity", "body", "valid_from", "valid_to", "confidence", "sensitivity", "event_ids"]);
const CLAIM_RULES = new Set(["text", "size_cap", "json", "object", "missing_field", "extra_field", "list", "list_cap", "bounded_string", "enum", "timestamp", "confidence", "event_ids", "verbatim"]);
const RESPONSE_RULES = new Set(["tool_call", "bad_response", "unsupported_metadata", "response_refused", "response_truncated", "response_incomplete", "response_too_large"]);
const TRANSPORT_RULES = new Set(["timeout", "network", "redirect", "credentials", "http", "unavailable"]);
const BUDGET_RULES = new Set(["max_calls", "max_input_tokens", "max_output_tokens", "max_quoted_chars"]);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const nullableCount = (value: unknown): value is number | null => value === null || count(value);
const keysAre = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));

export function diagnosticShape(value: unknown): DiagnosticShape {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return SHAPES.has(type) ? type as DiagnosticShape : "other";
}

/** Revalidate optional port diagnostics before logging, journaling or displaying. */
export function readProducerDiagnostic(value: unknown): ProducerDiagnostic | undefined {
  if (!isPlainObject(value) || typeof value.rule !== "string") return undefined;
  const rule = value.rule;
  if (value.stage === "claims" && CLAIM_RULES.has(rule) && typeof value.field === "string" && FIELDS.has(value.field) &&
      typeof value.shape === "string" && SHAPES.has(value.shape) && nullableCount(value.claim_index) && nullableCount(value.claim_count) &&
      keysAre(value, ["stage", "rule", "field", "shape", "claim_index", "claim_count"])) {
    return { stage: "claims", rule: rule as ClaimDiagnostic["rule"], field: value.field as ClaimDiagnostic["field"],
      shape: value.shape as DiagnosticShape, claim_index: value.claim_index, claim_count: value.claim_count };
  }
  if (value.stage === "response" && RESPONSE_RULES.has(rule) && keysAre(value, ["stage", "rule"])) {
    return { stage: "response", rule: rule as Extract<ProducerDiagnostic, { stage: "response" }>["rule"] };
  }
  if (value.stage === "transport" && TRANSPORT_RULES.has(rule) && keysAre(value, ["stage", "rule", "http_status"])) {
    if (value.http_status !== undefined && (rule !== "http" || !count(value.http_status) || value.http_status < 100 || value.http_status > 599)) return undefined;
    return { stage: "transport", rule: rule as Extract<ProducerDiagnostic, { stage: "transport" }>["rule"],
      ...(value.http_status === undefined ? {} : { http_status: value.http_status }) };
  }
  if (value.stage === "budget" && BUDGET_RULES.has(rule) && count(value.used) && count(value.requested) && count(value.limit) &&
      keysAre(value, ["stage", "rule", "used", "requested", "limit"])) {
    return { stage: "budget", rule: rule as Extract<ProducerDiagnostic, { stage: "budget" }>["rule"], used: value.used, requested: value.requested, limit: value.limit };
  }
  return undefined;
}

export function formatProducerDiagnostic(value: ProducerDiagnostic): string {
  const rule = value.rule.replaceAll("_", " ");
  switch (value.stage) {
    case "claims": return `claims ${rule}: field=${value.field} index=${value.claim_index ?? "unknown"} count=${value.claim_count ?? "unknown"} shape=${value.shape}`;
    case "response": return `model response rejected: ${rule}`;
    case "transport": return `model transport: ${rule}${value.http_status === undefined ? "" : ` status=${value.http_status}`}`;
    case "budget": return `producer budget ${value.rule}: used=${value.used} requested=${value.requested} limit=${value.limit}`;
  }
}
