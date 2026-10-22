import { EXTRACT_RESPONSE_V2_SCHEMA, MAX_V2_ANCHORS, MAX_V2_ANCHORS_PER_ITEM, MAX_V2_CLAIMS, MAX_V2_MENTIONS, MAX_V2_QUOTED_UTF16, MAX_V2_RESPONSE_BYTES, type ProducerV2ParseInput, type TextAnchor } from "../contracts/producer-v2";
import { canonicalJson, sha256Hex } from "../util/hash";
import { cloneExactJson, isPlainObject, unwrapJsonCodeFence, utf8ByteLength } from "../util/validate";

/** Private model transport only. Public producer and durable contracts remain numeric v2. */
export const MODEL_EXTRACTION_WIRE_SCHEMA = "kizuki.model-extraction/quote-anchors-v1" as const;
export const MODEL_EXTRACTION_WIRE_RECEIPT_SCHEMA = "kizuki.model-extraction-anchor-resolution/v1" as const;
export interface ModelQuoteAnchor { readonly event_id: string; readonly quote: string; readonly select?: string }
export interface ModelExtractionWireReceipt {
  readonly schema: typeof MODEL_EXTRACTION_WIRE_RECEIPT_SCHEMA;
  readonly wire_schema: typeof MODEL_EXTRACTION_WIRE_SCHEMA;
  readonly raw_response_sha256: string;
  readonly outbound_sha256: string;
  readonly events: readonly { readonly event_id: string; readonly text_sha256: string; readonly utf16_length: number }[];
  readonly resolutions: readonly { readonly path: string; readonly descriptor: ModelQuoteAnchor; readonly anchor: TextAnchor }[];
  readonly translated_response_sha256: string;
}
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const boundary = (text: string, at: number) => at <= 0 || at >= text.length || !(text.charCodeAt(at - 1) >= 0xd800 && text.charCodeAt(at - 1) <= 0xdbff && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff);
function uniqueOffset(text: string, quote: string): number | null {
  const at = text.indexOf(quote);
  return at >= 0 && text.indexOf(quote, at + 1) < 0 ? at : null;
}

/** Canonical model-only descriptor for one already-sent numeric source range.
 * The largest context that excludes adjacent copies is unique iff any such
 * context can identify this range. No offset arithmetic is delegated to a model.
 */
export function modelQuoteAnchorForSpan(anchor: TextAnchor, events: readonly { readonly event_id: string; readonly text: string }[]): ModelQuoteAnchor | null {
  const text = events.find(event => event.event_id === anchor.event_id)?.text;
  const start = anchor.start_utf16, end = anchor.end_utf16;
  if (text === undefined || text.length > MAX_V2_QUOTED_UTF16 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length || !boundary(text, start) || !boundary(text, end)) return null;
  const selected = text.slice(start, end);
  if (uniqueOffset(text, selected) === start) return { event_id: anchor.event_id, quote: selected };
  const previous = start === 0 ? -1 : text.lastIndexOf(selected, start - 1);
  const next = text.indexOf(selected, start + 1);
  let left = previous < 0 ? 0 : previous + 1;
  let right = next < 0 ? text.length : next + selected.length - 1;
  while (!boundary(text, left)) left++;
  while (!boundary(text, right)) right--;
  if (left > start || right < end) return null;
  const quote = text.slice(left, right);
  if (uniqueOffset(text, quote) !== left || uniqueOffset(quote, selected) !== start - left) return null;
  return { event_id: anchor.event_id, quote, select: selected };
}

/** Resolve all anchors or reject all. No interpretation, normalization, mutation or partial salvage. */
export function resolveModelExtractionWire(text: string, input: ProducerV2ParseInput): { readonly ok: true; readonly text: string; readonly receipt: ModelExtractionWireReceipt } | { readonly ok: false } {
  if (typeof text !== "string" || text.length > MAX_V2_RESPONSE_BYTES || utf8ByteLength(text) > MAX_V2_RESPONSE_BYTES) return { ok: false };
  let decoded: unknown;
  try {
    const errors: string[] = [];
    decoded = cloneExactJson(JSON.parse(unwrapJsonCodeFence(text)), "model wire", { maxDepth: 16, maxKeysPerObject: 32, maxArrayLength: 1024, maxStringBytes: MAX_V2_QUOTED_UTF16 * 4, maxKeyBytes: 64, maxTotalBytes: MAX_V2_RESPONSE_BYTES }, errors);
    if (errors.length > 0) return { ok: false };
    // The validator freezes its bounded snapshot; translation owns a mutable copy.
    decoded = structuredClone(decoded);
  } catch { return { ok: false }; }
  if (!isPlainObject(decoded) || !exact(decoded, ["schema", "mentions", "claims"]) || decoded.schema !== MODEL_EXTRACTION_WIRE_SCHEMA || !Array.isArray(decoded.mentions) || decoded.mentions.length > MAX_V2_MENTIONS || !Array.isArray(decoded.claims) || decoded.claims.length > MAX_V2_CLAIMS) return { ok: false };
  const pending: { path: string; descriptor: ModelQuoteAnchor; put: (anchor: TextAnchor) => void }[] = [];
  const add = (raw: unknown, path: string, put: (anchor: TextAnchor) => void): boolean => {
    if (!isPlainObject(raw) || !exact(raw, Object.hasOwn(raw, "select") ? ["event_id", "quote", "select"] : ["event_id", "quote"]) || typeof raw.event_id !== "string" || typeof raw.quote !== "string" || raw.quote.length === 0 || raw.quote.length > MAX_V2_QUOTED_UTF16 || (Object.hasOwn(raw, "select") && (typeof raw.select !== "string" || raw.select.length === 0 || raw.select.length > MAX_V2_QUOTED_UTF16))) return false;
    pending.push({ path, descriptor: { event_id: raw.event_id, quote: raw.quote, ...(typeof raw.select === "string" ? { select: raw.select } : {}) }, put });
    return pending.length <= MAX_V2_ANCHORS;
  };
  const addList = (raw: unknown, path: string): boolean => Array.isArray(raw) && raw.length <= MAX_V2_ANCHORS_PER_ITEM && raw.every((anchor, index) => add(anchor, `${path}[${index}]`, value => { raw[index] = value; }));
  for (const [index, mention] of decoded.mentions.entries()) {
    if (!isPlainObject(mention) || !add(mention.anchor, `mentions[${index}].anchor`, anchor => { mention.anchor = anchor; })) return { ok: false };
  }
  for (const [index, claim] of decoded.claims.entries()) {
    if (!isPlainObject(claim) || !isPlainObject(claim.perspective) || !addList(claim.anchors, `claims[${index}].anchors`) || !addList(claim.perspective.anchors, `claims[${index}].perspective.anchors`)) return { ok: false };
  }
  // Validate every descriptor and count before any source-text search.
  const events = new Map(input.events.map(event => [event.event_id, event.text]));
  const resolutions: ModelExtractionWireReceipt["resolutions"][number][] = [];
  for (const item of pending) {
    const source = events.get(item.descriptor.event_id);
    if (source === undefined) return { ok: false };
    const quoteAt = uniqueOffset(source, item.descriptor.quote);
    if (quoteAt === null) return { ok: false };
    const selected = item.descriptor.select ?? item.descriptor.quote;
    const selectAt = item.descriptor.select === undefined ? 0 : uniqueOffset(item.descriptor.quote, selected);
    if (selectAt === null) return { ok: false };
    const start = quoteAt + selectAt, end = start + selected.length;
    if (!boundary(source, quoteAt) || !boundary(source, quoteAt + item.descriptor.quote.length) || !boundary(source, start) || !boundary(source, end)) return { ok: false };
    const anchor = { event_id: item.descriptor.event_id, start_utf16: start, end_utf16: end };
    resolutions.push({ path: item.path, descriptor: item.descriptor, anchor });
    item.put(anchor);
  }
  decoded.schema = EXTRACT_RESPONSE_V2_SCHEMA;
  const translated = canonicalJson(decoded);
  return { ok: true, text: translated, receipt: {
    schema: MODEL_EXTRACTION_WIRE_RECEIPT_SCHEMA, wire_schema: MODEL_EXTRACTION_WIRE_SCHEMA,
    raw_response_sha256: sha256Hex(text), outbound_sha256: sha256Hex(canonicalJson(input)),
    events: input.events.map(event => ({ event_id: event.event_id, text_sha256: sha256Hex(event.text), utf16_length: event.text.length })),
    resolutions, translated_response_sha256: sha256Hex(translated),
  } };
}
