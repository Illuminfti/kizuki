import { describe, expect, test } from "bun:test";
import {
  EXTRACT_RESPONSE_V2_SCHEMA,
  parseExtractResponseV2,
  type ExtractResponseV2,
  type ProducerV2ParseInput,
} from "../../src/contracts/producer-v2";

const input: ProducerV2ParseInput = {
  events: [{ event_id: "00000000000000000000000001", text: "Mira joined Northwind." }],
  supplied_refs: [{ id: "s0", anchors: [{ event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 }] }],
  vocabulary_refs: ["v-person"],
  predicates: [{ id: "classification.instance_of", object_kinds: ["vocabulary"] }],
};

const response = {
  schema: EXTRACT_RESPONSE_V2_SCHEMA,
  mentions: [{
    id: "m0",
    label: "Mira",
    anchor: { event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 },
    candidate_refs: [{ kind: "supplied", id: "s0" }],
  }],
  claims: [{
    id: "c0",
    subject: { kind: "mention", id: "m0" },
    predicate: "classification.instance_of",
    object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "v-person" } },
    perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
    context: [],
    polarity: "positive",
    body: "Mira is a person.",
    valid_from: null,
    valid_to: null,
    temporal_basis: "unknown",
    confidence: 0.8,
    sensitivity: "personal",
    anchors: [{ event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 4 }],
  }],
} satisfies ExtractResponseV2;

function parse(value: unknown, context = input) {
  return parseExtractResponseV2(JSON.stringify(value), context);
}

describe("producer v2 response parser", () => {
  test("accepts a closed response with source-grounded open subjects", () => {
    expect(parse(response)).toEqual({ ok: true, response, dropped: [] });
  });

  test("rejects a reversed interval ending at a leap second", () => {
    expect(parse({
      ...response,
      claims: [{
        ...response.claims[0]!,
        temporal_basis: "explicit",
        valid_from: "2017-01-01T00:00:00Z",
        valid_to: "2016-12-31T23:59:60Z",
      }],
    })).toMatchObject({ ok: false });
  });

  test("accepts an increasing interval within one millisecond", () => {
    expect(parse({
      ...response,
      claims: [{
        ...response.claims[0]!,
        temporal_basis: "explicit",
        valid_from: "2026-01-01T00:00:00.0001Z",
        valid_to: "2026-01-01T00:00:00.0002Z",
      }],
    })).toMatchObject({ ok: true });
  });

  test("rejects equal interval endpoints with different UTC offsets", () => {
    expect(parse({
      ...response,
      claims: [{
        ...response.claims[0]!,
        temporal_basis: "explicit",
        valid_from: "2026-01-01T00:00:00Z",
        valid_to: "2026-01-01T01:00:00+01:00",
      }],
    })).toMatchObject({ ok: false });
  });

  test("rejects an arbitrary durable reference and an unknown local reference", () => {
    const arbitrary = structuredClone(response) as any;
    arbitrary.mentions[0]!.candidate_refs = [{ kind: "supplied", id: "durable-secret-id" }];
    expect(parse(arbitrary)).toMatchObject({ ok: false, detail: expect.stringContaining("candidate_refs") });

    const unknown = structuredClone(response) as any;
    unknown.claims[0]!.subject = { kind: "mention", id: "m404" };
    expect(parse(unknown)).toMatchObject({ ok: false, detail: expect.stringContaining("subject") });
  });

  test("rejects malformed anchors, including surrogate splitting and absent events", () => {
    const surrogateContext = { ...input, events: [{ event_id: "00000000000000000000000001", text: "A😀B" }] };
    const surrogate = structuredClone(response) as any;
    surrogate.mentions[0]!.anchor = { event_id: "00000000000000000000000001", start_utf16: 1, end_utf16: 2 };
    surrogate.claims[0]!.anchors = [{ event_id: "00000000000000000000000001", start_utf16: 0, end_utf16: 1 }];
    expect(parse(surrogate, surrogateContext)).toMatchObject({ ok: false, detail: expect.stringContaining("anchor") });

    const absent = structuredClone(response) as any;
    absent.claims[0]!.anchors = [{ event_id: "00000000000000000000000002", start_utf16: 0, end_utf16: 4 }];
    expect(parse(absent)).toMatchObject({ ok: false, detail: expect.stringContaining("anchors") });
  });

  test("rejects extra keys and duplicate local ids", () => {
    expect(parse({ ...response, extra: true })).toMatchObject({ ok: false, detail: expect.stringContaining("schema") });
    const duplicate = structuredClone(response) as any;
    duplicate.claims.push({ ...duplicate.claims[0]!, id: "c0" });
    expect(parse(duplicate)).toMatchObject({ ok: false, detail: expect.stringContaining("duplicate") });
  });

  test("accepts cyclic mention nominations without treating them as identity effects", () => {
    const cyclic = structuredClone(response) as any;
    cyclic.mentions.push({
      id: "m1",
      label: "Northwind",
      anchor: { event_id: "00000000000000000000000001", start_utf16: 12, end_utf16: 21 },
      candidate_refs: [{ kind: "mention", id: "m0" }],
    });
    cyclic.mentions[0]!.candidate_refs = [{ kind: "mention", id: "m1" }];
    expect(parse(cyclic)).toMatchObject({ ok: true, response: { mentions: cyclic.mentions } });
  });

  test("drops an unknown registered predicate without accepting an illegal vocabulary use", () => {
    const unknown = structuredClone(response) as any;
    unknown.claims[0]!.predicate = "relation.newly-invented";
    expect(parse(unknown)).toMatchObject({ ok: true, response: { mentions: response.mentions, claims: [] }, dropped: [{ reason: "unknown_predicate", id: "c0" }] });

    const illegal = structuredClone(response) as any;
    illegal.claims[0]!.predicate = "classification.instance_of";
    illegal.claims[0]!.object = { kind: "literal", value: "person" };
    expect(parse(illegal)).toMatchObject({ ok: false, detail: expect.stringContaining("object") });
  });

  test("requires attribution evidence whenever a perspective endpoint is named", () => {
    const attributed = structuredClone(response) as any;
    attributed.claims[0]!.perspective.speaker = { kind: "mention", id: "m0" };
    expect(parse(attributed)).toMatchObject({ ok: false, detail: expect.stringContaining("perspective.anchors") });
  });

  test("rejects trusted input that exceeds the bounded event context", () => {
    const events = Array.from({ length: 9 }, (_, index) => ({ event_id: String(index).padStart(26, "0"), text: "synthetic" }));
    expect(parse(response, { ...input, events })).toEqual({ ok: false, detail: "trusted parser input is invalid" });
    expect(parse(response, { ...input, events: [{ event_id: "00000000000000000000000001", text: "x".repeat(24_001) }] })).toEqual({ ok: false, detail: "trusted event input is invalid" });
  });

  test("malformed context is a fixed rejection, including throwing accessors", () => {
    const malformed = [null, {}, { ...input, supplied_refs: [null] }, new Proxy({}, {
      get() { throw Error("synthetic-private-context-canary"); },
    })];
    for (const context of malformed) {
      const result = parse(response, context as never);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("synthetic-private-context-canary");
    }
  });

  test("event identities follow the canonical spine ULID contract", () => {
    expect(parse({ schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [], claims: [] }, {
      ...input, events: [{ event_id: "event-1", text: "Mira joined Northwind." }], supplied_refs: [],
    }).ok).toBe(false);
  });

  test("bounds aggregate references independently of item and anchor caps", () => {
    const mentions = Array.from({ length: 8 }, (_, index) => ({
      ...response.mentions[0]!, id: `m${index}`,
      candidate_refs: Array.from({ length: 4 }, (_, ref) => ({ kind: "mention" as const, id: `m${ref}` })),
    }));
    const claims = Array.from({ length: 100 }, (_, index) => ({
      ...response.claims[0]!, id: `c${index}`,
      context: mentions.map(mention => ({ kind: "mention" as const, id: mention.id })),
    }));
    expect(parse({ ...response, mentions, claims: claims.slice(0, 99) }).ok).toBe(true);
    expect(parse({ ...response, mentions, claims })).toEqual({ ok: false, detail: "response exceeds reference cap" });
  });
});
