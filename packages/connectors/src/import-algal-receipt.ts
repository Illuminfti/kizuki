import { isPlainObject, isRfc3339, validateEventInput, type CaptureEventInput } from "@kizuki/core";
import { encodeSourceRecordId, sha256Hex } from "./source-id";

/** Pinned hraness/algal receipt admission. Not a dependency and not a replay. */
export const ALGAL_RUN_RECEIPT_PIN = Object.freeze({
  repository: "hraness/algal",
  commit: "5c976f0cb688fb0e28bc045c2410164867e83b35",
  receiptBlob: "ea26f011f135f25a03c0d93e586dc2c9947869d1",
  contract: "algal.run.v1",
});

/** Draft identity only. Not registered, not a command, and not ingress. */
export const ALGAL_RECEIPT_CONNECTOR_ID = "kizuki.import-algal-receipt";
export const ALGAL_RECEIPT_CONSENT = "owner-selected-local-file";
export const MAX_ALGAL_RECEIPT_BYTES = 64 * 1024;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const OUTCOMES = new Set(["complete", "failed", "stuck", "suspended"]);
const CELL_STATUS = new Set(["committed", "skipped", "failed", "suspended"]);
const EVENT_KINDS = new Set([
  "run.start", "cell.commit", "cell.skip", "cell.fail", "cell.suspend", "effect", "run.end",
]);
const FAILURE_CODES = new Set([
  "PARSE_FAILED", "MANIFEST_INVALID", "GRAPH_CYCLE", "TYPE_MISMATCH", "GUARD_INVALID",
  "SCORER_INVALID", "AXIS_INVALID", "INTERFACE_MISMATCH", "DEPTH_EXCEEDED", "INPUT_MISSING",
  "FN_UNKNOWN", "FN_FAILED", "EXPR_FAILED", "TOOL_UNKNOWN", "TOOL_FAILED", "EFFECT_FAILED",
  "EFFECT_UNPARSEABLE", "EFFECT_UNBOUND", "EFFECT_SUSPENDED", "CAPABILITY_DENIED",
  "MAILBOX_FULL", "BUDGET_EXHAUSTED", "STUCK", "STORE_MISS", "DIGEST_MISMATCH",
  "RECEIPT_MISMATCH", "IO_FAILED", "INTERNAL",
]);
const ROOT_KEYS = [
  "contract", "runtime", "manifestDigest", "manifestKey", "args", "outcome",
  "cells", "effects", "events", "work", "failure", "digest",
];
const CELL_KEYS = [
  "status", "outputs", "failure", "work", "effectDigest", "toolCalls",
  "shadowOut", "rounds", "items", "via", "slot",
];
const EFFECT_KEYS = [
  "requestDigest", "output", "error", "executor", "usage", "cached",
  "retryable", "wake", "configurationDigest",
];

export type AlgalReceiptCode =
  | "ok"
  | "referenced_bytes_unavailable"
  | "consent_required"
  | "invalid_observation"
  | "byte_limit"
  | "bound_exceeded"
  | "invalid_json"
  | "not_object"
  | "unsupported_contract"
  | "unsupported_field"
  | "invalid_digest"
  | "invalid_record"
  | "unavailable"
  | "digest_mismatch"
  | "unexpected_reference";

export type AlgalReceiptParse =
  | {
      status: "normalized" | "partial";
      code: "ok" | "referenced_bytes_unavailable";
      event: CaptureEventInput;
      missingDigests: readonly string[];
    }
  | { status: "refused"; code: Exclude<AlgalReceiptCode, "ok" | "referenced_bytes_unavailable">; reason: string };

type Refusal = Extract<AlgalReceiptParse, { status: "refused" }>;

function refused(code: Refusal["code"], reason: string): Refusal {
  return { status: "refused", code, reason };
}

function allowed(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function digest(value: unknown): string | Refusal {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    return refused("invalid_digest", "content address must be sha256 and 64 lowercase hex digits");
  }
  return value;
}

function bounded(value: unknown, depth = 0, state = { nodes: 0 }): Refusal | undefined {
  state.nodes += 1;
  if (state.nodes > 1024 || depth > 12) return refused("bound_exceeded", "receipt exceeds the adapter bound");
  if (typeof value === "string") {
    return value.length > 65_536 ? refused("bound_exceeded", "receipt string exceeds the adapter bound") : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) return refused("bound_exceeded", "receipt array exceeds the adapter bound");
    for (const item of value) {
      const stop = bounded(item, depth + 1, state);
      if (stop) return stop;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length > 256) return refused("bound_exceeded", "receipt object exceeds the adapter bound");
  for (const key of keys) {
    if (key.length > 256) return refused("bound_exceeded", "receipt key exceeds the adapter bound");
    const stop = bounded(value[key], depth + 1, state);
    if (stop) return stop;
  }
  return undefined;
}

function integer(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function failure(value: unknown, withPath: boolean): Refusal | undefined {
  if (!isPlainObject(value) || !allowed(value, withPath ? ["code", "message", "path"] : ["code", "message"])) {
    return refused("invalid_record", "failure record is not the pinned shape");
  }
  if (typeof value["code"] !== "string" || !FAILURE_CODES.has(value["code"]) || !text(value["message"], 65_536)) {
    return refused("invalid_record", "failure code or message is not pinned");
  }
  if (value["path"] !== undefined && !text(value["path"], 4096)) {
    return refused("invalid_record", "failure path is not a bounded label");
  }
  return undefined;
}

function validateReceipt(raw: Record<string, unknown>): { refs: string[] } | Refusal {
  if (!allowed(raw, ROOT_KEYS)) return refused("unsupported_field", "receipt has a field outside the pinned profile");
  if (raw["contract"] !== ALGAL_RUN_RECEIPT_PIN.contract) {
    return refused("unsupported_contract", "only algal.run.v1 is accepted");
  }
  const runtime = raw["runtime"];
  if (!isPlainObject(runtime) || !allowed(runtime, ["name", "version"]) || runtime["name"] !== "algal" || !text(runtime["version"], 128)) {
    return refused("invalid_record", "runtime is not the pinned algal runtime");
  }
  if (raw["digest"] === undefined || raw["manifestDigest"] === undefined || raw["manifestKey"] === undefined) {
    return refused("unavailable", "receipt digest, manifest digest, or manifest key is missing");
  }
  const own = digest(raw["digest"]);
  if (typeof own !== "string") return own;
  const manifest = digest(raw["manifestDigest"]);
  if (typeof manifest !== "string") return manifest;
  if (!text(raw["manifestKey"], 256)) return refused("invalid_record", "manifest key is not a bounded label");
  if (!isPlainObject(raw["args"])) return refused("invalid_record", "args must be an object");
  for (const input of Object.values(raw["args"])) {
    if (!isPlainObject(input)) return refused("invalid_record", "each args value must be an object");
  }
  if (typeof raw["outcome"] !== "string" || !OUTCOMES.has(raw["outcome"])) {
    return refused("invalid_record", "outcome is not a pinned run outcome");
  }
  const work = raw["work"];
  if (!isPlainObject(work) || !allowed(work, ["steps", "agentCalls", "units"])) {
    return refused("invalid_record", "work is not the pinned shape");
  }
  if (!integer(work["steps"]) || !integer(work["agentCalls"]) || !integer(work["units"])) {
    return refused("invalid_record", "work counts must be non-negative safe integers");
  }
  if (raw["failure"] !== undefined) {
    const stop = failure(raw["failure"], true);
    if (stop) return stop;
  }
  const refs = [manifest];
  const cells = raw["cells"];
  if (!isPlainObject(cells)) return refused("unavailable", "cells are missing");
  for (const cell of Object.values(cells)) {
    if (!isPlainObject(cell) || !allowed(cell, CELL_KEYS)) return refused("unsupported_field", "cell has a field outside the pinned profile");
    if (typeof cell["status"] !== "string" || !CELL_STATUS.has(cell["status"]) || !integer(cell["work"])) {
      return refused("invalid_record", "cell status or work is not pinned");
    }
    if (cell["effectDigest"] !== undefined) {
      const ref = digest(cell["effectDigest"]);
      if (typeof ref !== "string") return ref;
      refs.push(ref);
    }
    if (cell["failure"] !== undefined) {
      const stop = failure(cell["failure"], false);
      if (stop) return stop;
    }
  }
  if (!Array.isArray(raw["effects"]) || !Array.isArray(raw["events"])) {
    return refused("unavailable", "effects or events are missing");
  }
  for (const effect of raw["effects"]) {
    if (!isPlainObject(effect) || !allowed(effect, EFFECT_KEYS)) return refused("unsupported_field", "effect has a field outside the pinned profile");
    const request = digest(effect["requestDigest"]);
    if (typeof request !== "string") return request;
    refs.push(request);
    if ((effect["output"] === undefined) === (effect["error"] === undefined)) {
      return refused("invalid_record", "effect needs exactly one output or error");
    }
    if (effect["error"] !== undefined) {
      const stop = failure(effect["error"], false);
      if (stop) return stop;
    }
    if (!text(effect["executor"], 256)) return refused("invalid_record", "effect executor is not a bounded label");
    if (effect["configurationDigest"] !== undefined) {
      const ref = digest(effect["configurationDigest"]);
      if (typeof ref !== "string") return ref;
      refs.push(ref);
    }
  }
  for (const event of raw["events"]) {
    if (!isPlainObject(event) || !allowed(event, ["seq", "kind", "path", "digest", "outcome"])) {
      return refused("unsupported_field", "event has a field outside the pinned profile");
    }
    if (!integer(event["seq"]) || typeof event["kind"] !== "string" || !EVENT_KINDS.has(event["kind"])) {
      return refused("invalid_record", "event sequence or kind is not pinned");
    }
    if (event["digest"] !== undefined) {
      const ref = digest(event["digest"]);
      if (typeof ref !== "string") return ref;
      refs.push(ref);
    }
  }
  return { refs: [...new Set(refs)] };
}

/**
 * Parse one owner-selected algal.run.v1 receipt. The caller passes bytes.
 * This function does not open paths, retrieve URLs, or run imported code.
 */
export function parseAlgalRunReceipt(
  source: string,
  input: { observedAt: string; consent?: string; referencedBytes?: Readonly<Record<string, string>> },
): AlgalReceiptParse {
  if (input.consent !== ALGAL_RECEIPT_CONSENT) {
    return refused("consent_required", "explicit owner-selected local file consent is required");
  }
  if (!isRfc3339(input.observedAt)) return refused("invalid_observation", "observedAt must be RFC3339");
  if (Buffer.byteLength(source, "utf8") > MAX_ALGAL_RECEIPT_BYTES) {
    return refused("byte_limit", "receipt exceeds the adapter byte limit");
  }
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { return refused("invalid_json", "receipt is not one JSON value"); }
  if (!isPlainObject(raw)) return refused("not_object", "receipt must be one JSON object");
  const stop = bounded(raw);
  if (stop) return stop;
  const checked = validateReceipt(raw);
  if ("status" in checked) return checked;

  const supplied = input.referencedBytes;
  if (supplied !== undefined && !isPlainObject(supplied)) {
    return refused("invalid_record", "referenced bytes must be a record of digest to text");
  }
  const have = new Set<string>();
  if (supplied !== undefined) {
    for (const [key, bytes] of Object.entries(supplied)) {
      if (!DIGEST.test(key) || !checked.refs.includes(key)) {
        return refused("unexpected_reference", "referenced bytes name a digest this receipt does not use");
      }
      if (typeof bytes !== "string") return refused("invalid_record", "referenced bytes must be text");
      if (`sha256:${sha256Hex(bytes)}` !== key) return refused("digest_mismatch", "supplied bytes do not match the content address");
      have.add(key);
    }
  }
  const missingDigests = checked.refs.filter((ref) => !have.has(ref));
  const partial = missingDigests.length > 0;
  const manifest = raw["manifestDigest"];
  const own = raw["digest"];
  const draft: CaptureEventInput = {
    schema: "kizuki.event/v1",
    connector_id: ALGAL_RECEIPT_CONNECTOR_ID,
    source_record_id: encodeSourceRecordId(["algal.run.v1", String(own)]),
    kind: "agent_runtime",
    occurred_at: input.observedAt,
    observed_at: input.observedAt,
    text: [
      "ALGAL run receipt (unverified, not executed, bytes not retrieved):",
      `outcome ${String(raw["outcome"])}`,
      `manifest ${String(manifest)}`,
      `receipt ${String(own)}`,
      "source clock absent; occurred_at is the observation time",
    ].join("\n"),
    subjects: [],
    sensitivity_hint: "private",
    deleted: false,
    attachments: [],
    metadata: {
      algal: {
        schema: "kizuki.algal-receipt-import/v1",
        pin: ALGAL_RUN_RECEIPT_PIN,
        receipt: raw,
        coverage: {
          receipt_digest: "format_checked_not_replayed",
          referenced_bytes: partial ? "unavailable" : "supplied",
          missing_digests: missingDigests,
          retrieved: false,
          executed: false,
          source_clock: "absent",
        },
      },
    },
  };
  const event = validateEventInput(draft);
  if (!event.ok) return refused("invalid_record", "receipt does not fit kizuki.event/v1");
  return partial
    ? { status: "partial", code: "referenced_bytes_unavailable", event: event.value, missingDigests }
    : { status: "normalized", code: "ok", event: event.value, missingDigests };
}
