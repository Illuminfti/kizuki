import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_V2_ANCHORS, MAX_V2_QUOTED_UTF16, type ExtractResponseV2, type ProduceInputV2, type ProducerV2ParseInput, type TextAnchor } from "../../packages/core/src/contracts/producer-v2";
import { planModelExtractionV2 } from "../../packages/core/src/producer/model-v2";
import {
  MODEL_EXTRACTION_WIRE_RECEIPT_SCHEMA,
  MODEL_EXTRACTION_WIRE_SCHEMA,
  type ModelExtractionWireReceipt,
} from "../../packages/core/src/producer/model-v2-wire";
import { isPlainObject } from "../../packages/core/src/util/validate";
import { canonicalJson, sha256 } from "../evaluate-extraction";

export const MODEL_WIRE_ADAPTER_PATH = "packages/core/src/producer/model-v2-wire.ts" as const;
const HASH = /^[a-f0-9]{64}$/;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export interface ModelWireAdapterIdentity {
  readonly wire_schema: typeof MODEL_EXTRACTION_WIRE_SCHEMA;
  readonly receipt_schema: typeof MODEL_EXTRACTION_WIRE_RECEIPT_SCHEMA;
  readonly source_sha256: string;
}

export interface CoreSemanticWireEvidence {
  readonly case_id: string;
  readonly transport_response_sha256: string;
  readonly adapter_source_sha256: string;
  readonly resolution_receipt_sha256: string;
  readonly receipt: ModelExtractionWireReceipt;
}

export interface CoreSemanticWireBinding {
  readonly wire_schema: string | null;
  readonly receipt_schema: string | null;
  readonly adapter_source_sha256: string | null;
  readonly raw_model_response_sha256: string | null;
  readonly transport_model_response_sha256: string | null;
  readonly outbound_sha256: string | null;
  readonly resolution_receipt_sha256: string | null;
  readonly translated_response_sha256: string | null;
}

export const emptyWireBinding = (): CoreSemanticWireBinding => ({
  wire_schema: null,
  receipt_schema: null,
  adapter_source_sha256: null,
  raw_model_response_sha256: null,
  transport_model_response_sha256: null,
  outbound_sha256: null,
  resolution_receipt_sha256: null,
  translated_response_sha256: null,
});

export function modelWireAdapterIdentity(root = resolve(import.meta.dir, "../..")): ModelWireAdapterIdentity {
  return {
    wire_schema: MODEL_EXTRACTION_WIRE_SCHEMA,
    receipt_schema: MODEL_EXTRACTION_WIRE_RECEIPT_SCHEMA,
    source_sha256: sha256(readFileSync(join(root, MODEL_WIRE_ADAPTER_PATH))),
  };
}

function expectedOutbound(input: ProduceInputV2): ProducerV2ParseInput | null {
  const plan = planModelExtractionV2(input);
  return plan.status === "ready" ? plan.outbound : null;
}

function exactAnchor(value: unknown, expected: TextAnchor): boolean {
  return isPlainObject(value) && exactKeys(value, ["event_id", "start_utf16", "end_utf16"]) &&
    value.event_id === expected.event_id && value.start_utf16 === expected.start_utf16 && value.end_utf16 === expected.end_utf16;
}

function boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset);
  return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
}

function responseAnchors(response: ExtractResponseV2): { path: string; anchor: TextAnchor }[] {
  return [
    ...response.mentions.map((mention, index) => ({ path: `mentions[${index}].anchor`, anchor: mention.anchor })),
    ...response.claims.flatMap((claim, index) => [
      ...claim.anchors.map((anchor, anchorIndex) => ({ path: `claims[${index}].anchors[${anchorIndex}]`, anchor })),
      ...claim.perspective.anchors.map((anchor, anchorIndex) => ({ path: `claims[${index}].perspective.anchors[${anchorIndex}]`, anchor })),
    ]),
  ];
}

function verifyResolutions(receipt: Record<string, unknown>, outbound: ProducerV2ParseInput, response: ExtractResponseV2): boolean {
  const expectedRows = responseAnchors(response);
  if (!Array.isArray(receipt.resolutions) || receipt.resolutions.length > MAX_V2_ANCHORS || receipt.resolutions.length !== expectedRows.length) return false;
  const events = new Map(outbound.events.map(event => [event.event_id, event.text])), paths = new Set<string>();
  for (const [index, raw] of receipt.resolutions.entries()) {
    if (!isPlainObject(raw) || !exactKeys(raw, ["path", "descriptor", "anchor"]) || typeof raw.path !== "string" ||
      raw.path.length === 0 || raw.path.length > 512 || paths.has(raw.path) || !isPlainObject(raw.descriptor)) return false;
    const expectedRow = expectedRows[index]!;
    if (raw.path !== expectedRow.path || !exactAnchor(raw.anchor, expectedRow.anchor)) return false;
    paths.add(raw.path);
    const descriptor = raw.descriptor, keys = Object.hasOwn(descriptor, "select") ? ["event_id", "quote", "select"] : ["event_id", "quote"];
    if (!exactKeys(descriptor, keys) || typeof descriptor.event_id !== "string" || typeof descriptor.quote !== "string" || descriptor.quote.length === 0 || descriptor.quote.length > MAX_V2_QUOTED_UTF16 ||
      (Object.hasOwn(descriptor, "select") && (typeof descriptor.select !== "string" || descriptor.select.length === 0 || descriptor.select.length > MAX_V2_QUOTED_UTF16))) return false;
    const text = events.get(descriptor.event_id);
    if (text === undefined || descriptor.quote.length > text.length) return false;
    const quoteStart = text.indexOf(descriptor.quote);
    if (quoteStart < 0 || text.indexOf(descriptor.quote, quoteStart + 1) >= 0) return false;
    const selected = Object.hasOwn(descriptor, "select") ? descriptor.select as string : descriptor.quote;
    const selectStart = descriptor.quote.indexOf(selected);
    if (selectStart < 0 || descriptor.quote.indexOf(selected, selectStart + 1) >= 0) return false;
    const expected = { event_id: descriptor.event_id, start_utf16: quoteStart + selectStart, end_utf16: quoteStart + selectStart + selected.length };
    if (!boundary(text, quoteStart) || !boundary(text, quoteStart + descriptor.quote.length) || !boundary(text, expected.start_utf16) || !boundary(text, expected.end_utf16) || !exactAnchor(raw.anchor, expected)) return false;
  }
  return true;
}

/** Independently verifies the adapter's canonical custody record without parsing private model wire again. */
export function inspectCoreSemanticWireEvidence(args: {
  readonly case_id: string;
  readonly input: ProduceInputV2;
  readonly response: ExtractResponseV2 | null;
  readonly transport_response_sha256: string | null;
  readonly model_response_sha256: string | null;
  readonly adapter: ModelWireAdapterIdentity;
  readonly evidence: readonly CoreSemanticWireEvidence[];
}): { readonly binding: CoreSemanticWireBinding; readonly errors: readonly string[] } {
  const matches = args.evidence.filter(row => row.case_id === args.case_id), row = matches[0], errors: string[] = [];
  if (matches.length !== 1 || row === undefined) return { binding: emptyWireBinding(), errors: ["wire_receipt_count"] };
  const binding: CoreSemanticWireBinding = {
    wire_schema: isPlainObject(row.receipt) && typeof row.receipt.wire_schema === "string" ? row.receipt.wire_schema : null,
    receipt_schema: isPlainObject(row.receipt) && typeof row.receipt.schema === "string" ? row.receipt.schema : null,
    adapter_source_sha256: row.adapter_source_sha256,
    raw_model_response_sha256: isPlainObject(row.receipt) && typeof row.receipt.raw_response_sha256 === "string" ? row.receipt.raw_response_sha256 : null,
    transport_model_response_sha256: args.model_response_sha256,
    outbound_sha256: isPlainObject(row.receipt) && typeof row.receipt.outbound_sha256 === "string" ? row.receipt.outbound_sha256 : null,
    resolution_receipt_sha256: row.resolution_receipt_sha256,
    translated_response_sha256: isPlainObject(row.receipt) && typeof row.receipt.translated_response_sha256 === "string" ? row.receipt.translated_response_sha256 : null,
  };
  if (!HASH.test(row.transport_response_sha256) || row.transport_response_sha256 !== args.transport_response_sha256) errors.push("wire_transport_mismatch");
  if (!HASH.test(args.model_response_sha256 ?? "") || !isPlainObject(row.receipt) || row.receipt.raw_response_sha256 !== args.model_response_sha256) errors.push("wire_raw_response_mismatch");
  if (!HASH.test(row.adapter_source_sha256) || row.adapter_source_sha256 !== args.adapter.source_sha256) errors.push("wire_adapter_mismatch");
  if (!HASH.test(row.resolution_receipt_sha256) || row.resolution_receipt_sha256 !== sha256(canonicalJson(row.receipt))) errors.push("wire_receipt_hash_mismatch");
  if (!isPlainObject(row.receipt) || !exactKeys(row.receipt, ["schema", "wire_schema", "raw_response_sha256", "outbound_sha256", "events", "resolutions", "translated_response_sha256"]) ||
      row.receipt.schema !== args.adapter.receipt_schema || row.receipt.wire_schema !== args.adapter.wire_schema ||
      typeof row.receipt.raw_response_sha256 !== "string" || !HASH.test(row.receipt.raw_response_sha256) ||
      typeof row.receipt.outbound_sha256 !== "string" || !HASH.test(row.receipt.outbound_sha256) ||
      typeof row.receipt.translated_response_sha256 !== "string" || !HASH.test(row.receipt.translated_response_sha256)) {
    errors.push("wire_schema_mismatch");
    return { binding, errors };
  }
  const outbound = expectedOutbound(args.input);
  if (outbound === null || row.receipt.outbound_sha256 !== sha256(canonicalJson(outbound))) errors.push("wire_outbound_mismatch");
  if (outbound !== null) {
    const expectedEvents = outbound.events.map(event => ({ event_id: event.event_id, text_sha256: sha256(event.text), utf16_length: event.text.length }));
    if (canonicalJson(row.receipt.events) !== canonicalJson(expectedEvents)) errors.push("wire_events_mismatch");
    if (args.response === null || !verifyResolutions(row.receipt, outbound, args.response)) errors.push("wire_resolution_mismatch");
  }
  if (args.response === null || row.receipt.translated_response_sha256 !== sha256(canonicalJson(args.response))) errors.push("wire_translated_response_mismatch");
  return { binding, errors };
}
