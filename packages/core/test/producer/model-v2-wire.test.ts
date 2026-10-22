import { expect, test } from "bun:test";
import { MODEL_EXTRACTION_WIRE_SCHEMA, resolveModelExtractionWire } from "../../src/producer/model-v2-wire";
import { canonicalJson, sha256Hex } from "../../src/util/hash";
import type { ProducerV2ParseInput } from "../../src/contracts/producer-v2";
const id = "00000000000000000000000001", other = "00000000000000000000000002";
const input = (text: string): ProducerV2ParseInput => ({ events: [{ event_id: id, text }], supplied_refs: [], predicates: [], vocabulary_refs: [] });
const wire = (anchor: unknown) => JSON.stringify({ schema: MODEL_EXTRACTION_WIRE_SCHEMA, mentions: [{ id: "m", label: "word", anchor, candidate_refs: [] }], claims: [] });
const resolve = (text: string, quote: string, select?: string) => resolveModelExtractionWire(wire({ event_id: id, quote, ...(select === undefined ? {} : { select }) }), input(text));
test("private quotes resolve exact UTF16 locations without changing combining characters", () => {
  const text = "prefix 🙂 e\u0301 end";
  const result = resolve(text, "🙂 e\u0301", "e\u0301");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("resolution failed");
  expect(JSON.parse(result.text).mentions[0].anchor).toEqual({ event_id: id, start_utf16: 10, end_utf16: 12 });
  expect(result.receipt).toMatchObject({ raw_response_sha256: sha256Hex(wire({ event_id: id, quote: "🙂 e\u0301", select: "e\u0301" })), outbound_sha256: sha256Hex(canonicalJson(input(text))), translated_response_sha256: sha256Hex(result.text) });
  expect(resolve(text, "é").ok).toBe(false);
  expect(resolve(text, "\ud83d").ok).toBe(false);
});
test("missing, duplicated, overlapping and outside quote/select never guess an occurrence", () => {
  for (const [text, quote, select] of [["x x", "x", undefined], ["aaaa", "aa", undefined], ["a b", "missing", undefined], ["x x y", "x x y", "x"], ["abc", "abc", "outside"], ["abc", "abc", ""]] as const) expect(resolve(text, quote, select).ok).toBe(false);
  expect(resolve("x x y", "x y", "x").ok).toBe(true);
  expect(resolve(" x ", " x ").ok).toBe(true);
});
test("events disambiguate identical quotes; wrong event and numeric output fail closed", () => {
  const plan = { ...input("same"), events: [{ event_id: id, text: "same" }, { event_id: other, text: "same" }] };
  const result = resolveModelExtractionWire(wire({ event_id: other, quote: "same" }), plan);
  expect(result.ok && JSON.parse(result.text).mentions[0].anchor.event_id).toBe(other);
  for (const anchor of [{ event_id: "unknown", quote: "same" }, { event_id: id, quote: "same", extra: 1 }, { event_id: id, start_utf16: 0, end_utf16: 4 }, { event_id: id, quote: "" }]) expect(resolveModelExtractionWire(wire(anchor), plan).ok).toBe(false);
});
test("a full near-production prefix retains exact indices and all nonanchor fields", () => {
  const source = "z".repeat(20_200) + " museum named Coil and changed order.";
  const raw = { schema: MODEL_EXTRACTION_WIRE_SCHEMA, mentions: [{ id: "m", label: "Coil", anchor: { event_id: id, quote: "Coil" }, candidate_refs: [] }], claims: [{ id: "c", body: "unchanged", perspective: { mode: "reported", interpretation: "explicit", holder: { kind: "mention", id: "m" }, anchors: [{ event_id: id, quote: "Coil" }] }, object: { kind: "literal", value: "changed order" }, valid_from: "2000-01-01T00:00:00Z", confidence: 0.53, anchors: [{ event_id: id, quote: "museum named Coil and changed order." }] }] };
  const result = resolveModelExtractionWire(JSON.stringify(raw), input(source));
  if (!result.ok) throw new Error("resolution failed");
  const actual = JSON.parse(result.text);
  expect(actual.claims[0]).toMatchObject({ body: raw.claims[0]!.body, object: raw.claims[0]!.object, valid_from: raw.claims[0]!.valid_from, confidence: 0.53, perspective: { mode: "reported", interpretation: "explicit", holder: { kind: "mention", id: "m" } } });
  expect(actual.mentions[0].anchor.start_utf16).toBe(source.indexOf("Coil"));
  expect(result.receipt.resolutions.map(row => row.path)).toEqual(["mentions[0].anchor", "claims[0].anchors[0]", "claims[0].perspective.anchors[0]"]);
});
test("all descriptor and item caps are checked before any text search", () => {
  const original = String.prototype.indexOf;
  let searches = 0;
  String.prototype.indexOf = function(search: string, position?: number) { searches++; return original.call(this, search, position); };
  try {
    const one = { id: "m", anchor: { event_id: id, quote: "a" } };
    for (const response of [
      { schema: MODEL_EXTRACTION_WIRE_SCHEMA, mentions: Array(65).fill(one), claims: [] },
      { schema: MODEL_EXTRACTION_WIRE_SCHEMA, mentions: [one, { ...one, anchor: { event_id: id, quote: "a".repeat(24_001) } }], claims: [] },
      { schema: MODEL_EXTRACTION_WIRE_SCHEMA, mentions: [], claims: [{ anchors: Array(9).fill(one.anchor), perspective: { anchors: [] } }] },
    ]) expect(resolveModelExtractionWire(JSON.stringify(response), input("a")).ok).toBe(false);
    expect(searches).toBe(0);
  } finally { String.prototype.indexOf = original; }
});
