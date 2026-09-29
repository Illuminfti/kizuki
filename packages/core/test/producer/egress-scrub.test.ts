import { afterEach, expect, test } from "bun:test";
import { EXTRACT_RESPONSE_V2_SCHEMA, type ProduceInputV2 } from "../../src/contracts/producer-v2";
import type { SystemOnePort, SystemOneRequest, SystemOneResponse } from "../../src/contracts/systemone";
import { validatePortDescriptor } from "../../src/contracts/ports";
import { createModelProducerPort, MODEL_PRODUCER_DESCRIPTOR } from "../../src/producer/model";
import { createModelProducerV2Port, MODEL_PRODUCER_V2_DESCRIPTOR } from "../../src/producer/model-v2";
import { scrubText } from "../../src/producer/scrub";
import { validateProduceResult } from "../../src/producer/result";
import { GRACE, GRACE_EVENT, draft, input, responseText, scriptedLlm, temporaryProducerContext } from "./helpers";

const EVENT = "00000000000000000000000001";
const SECRET = `sk-${"a".repeat(24)}`;
const PASSWORD_LINE = `DB_PASSWORD=${"p".repeat(12)}`;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const TEXT = `key ${SECRET}\n${PASSWORD_LINE}\nMira joined Northwind.`;
const SCRUBBED = scrubText(TEXT);
const at = (text: string, needle: string) => text.indexOf(needle);
const v2Input = (): ProduceInputV2 => ({
  events: [{ event_id: EVENT, text: TEXT }],
  supplied_refs: [{ id: "s0", anchors: [{ event_id: EVENT, start_utf16: at(TEXT, "Mira"), end_utf16: at(TEXT, "Mira") + 4 }] }],
  vocabulary_refs: ["v-person"], predicates: [{ id: "classification.instance_of", object_kinds: ["vocabulary"] }],
  budget: { max_calls: 1, max_input_tokens: 20_000, max_output_tokens: 2_000 },
});
function v2Response(anchor: { start_utf16: number; end_utf16: number }, label: string) {
  const a = { event_id: EVENT, ...anchor };
  return JSON.stringify({ schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [{ id: "m0", label, anchor: a, candidate_refs: [] }], claims: [{ id: "c0", subject: { kind: "mention", id: "m0" }, predicate: "classification.instance_of", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "v-person" } }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] }, context: [], polarity: "positive", body: "Someone is a person.", valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.8, sensitivity: "personal", anchors: [a] }] });
}
function v2Port(script: Parameters<typeof scriptedLlm>[0], systemone?: SystemOnePort) {
  const temp = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR); cleanups.push(temp.cleanup);
  const llm = scriptedLlm(script);
  return { llm, port: createModelProducerV2Port(temp.ctx, { llm, ...(systemone === undefined ? {} : { systemone }) }) };
}
const sent = (llm: { requests: readonly { messages: readonly { content: string }[] }[] }) => llm.requests.flatMap(request => request.messages.map(message => message.content)).join("\n");

test("typed extraction never sends a secret to the model and counts what it removed", async () => {
  const start = at(SCRUBBED.text, "Northwind");
  const { llm, port } = v2Port(() => v2Response({ start_utf16: start, end_utf16: start + 9 }, "Northwind"));
  const raw = v2Input();
  const result = await port.produce(raw);
  const prompt = sent(llm);
  expect(prompt).not.toContain(SECRET);
  expect(prompt).not.toContain("p".repeat(12));
  expect(prompt).toContain("[redacted:api_token]");
  expect(prompt).toContain("DB_PASSWORD=[redacted:secret_assignment]");
  expect(result).toMatchObject({ status: "ok", usage: { calls: 1, redacted: { api_token: 1, secret_assignment: 1 } } });
  expect(raw.events[0]!.text).toBe(TEXT);
});

test("typed extraction moves the model's anchors back onto the original text", async () => {
  const start = at(SCRUBBED.text, "Northwind");
  const { port } = v2Port(() => v2Response({ start_utf16: start, end_utf16: start + 9 }, "Northwind"));
  const result = await port.produce(v2Input());
  if (result.status !== "ok") throw new Error("expected ok");
  const anchor = result.response.claims[0]!.anchors[0]!;
  expect(TEXT.slice(anchor.start_utf16, anchor.end_utf16)).toBe("Northwind");
  expect(result.response.mentions[0]!.anchor).toEqual(anchor);
});

test("an anchor that lands on a redaction covers the whole secret and nothing leaks through it", async () => {
  const marker = SCRUBBED.redactions[0]!;
  const { port } = v2Port(() => v2Response({ start_utf16: marker.out_start + 2, end_utf16: marker.out_end - 2 }, "key"));
  const result = await port.produce(v2Input());
  if (result.status !== "ok") throw new Error("expected ok");
  const anchor = result.response.claims[0]!.anchors[0]!;
  expect(TEXT.slice(anchor.start_utf16, anchor.end_utf16)).toBe(SECRET);
});

test("a supplied handle anchored partway into a secret is cited back as the anchor the caller supplied", async () => {
  const marker = SCRUBBED.redactions[0]!;
  const supplied = { event_id: EVENT, start_utf16: 0, end_utf16: marker.start + 6 };
  const sentAnchor = { event_id: EVENT, start_utf16: 0, end_utf16: marker.out_end };
  const response = JSON.stringify({ schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [], claims: [{ id: "c0", subject: { kind: "supplied", id: "s0" }, predicate: "classification.instance_of", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "v-person" } }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] }, context: [], polarity: "positive", body: "Someone is a person.", valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.8, sensitivity: "personal", anchors: [sentAnchor] }] });
  const { llm, port } = v2Port(() => response);
  const result = await port.produce({ ...v2Input(), supplied_refs: [{ id: "s0", anchors: [supplied] }] });
  expect(sent(llm)).toContain(`"start_utf16":0,"end_utf16":${marker.out_end}`);
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  expect(result.response.claims[0]!.anchors).toEqual([supplied]);
});

test("supplied handles follow their text into the scrubbed prompt", async () => {
  const { llm, port } = v2Port(() => v2Response({ start_utf16: 0, end_utf16: 3 }, "key"));
  await port.produce(v2Input());
  const shifted = at(SCRUBBED.text, "Mira");
  expect(shifted).not.toBe(at(TEXT, "Mira"));
  expect(sent(llm)).toContain(`"start_utf16":${shifted},"end_utf16":${shifted + 4}`);
});

test("text without secrets is sent unchanged and reports no redaction", async () => {
  const { llm, port } = v2Port(() => v2Response({ start_utf16: 0, end_utf16: 4 }, "Mira"));
  const clean: ProduceInputV2 = { ...v2Input(), events: [{ event_id: EVENT, text: "Mira joined Northwind." }], supplied_refs: [] };
  const result = await port.produce(clean);
  expect(sent(llm)).toContain("Mira joined Northwind.");
  expect(result.usage).toEqual({ calls: 1, input_tokens: expect.any(Number), output_tokens: expect.any(Number) });
});

test("a configured judge sees the scrubbed events, never the original secret", async () => {
  const seen: SystemOneRequest[] = [];
  const judge: SystemOnePort = {
    descriptor: validatePortDescriptor({ id: "test.systemone.scrub", kind: "systemone", contract: "kizuki.systemone/v1", contract_minor: 0, supports: ["evaluate"], requires_lease: false, optional_package: null }),
    model_ref: "test-judge", async health() { return { status: "ready", detail: {} }; }, async close() {},
    async evaluate(request): Promise<SystemOneResponse> { seen.push(request); return { model: "test-judge", answers: { admit_0: { type: "noul", noul: 0.95 } }, usage: { input_tokens: 1, output_tokens: 1 } }; },
  };
  const start = at(SCRUBBED.text, "Northwind");
  const { port } = v2Port(() => v2Response({ start_utf16: start, end_utf16: start + 9 }, "Northwind"), judge);
  const result = await port.produce(v2Input());
  expect(result.status).toBe("ok");
  expect(JSON.stringify(seen)).not.toContain(SECRET);
  expect(JSON.stringify(seen)).toContain("[redacted:api_token]");
});

test("the v1 extraction prompt is scrubbed in event text, display names and known claims", async () => {
  const temp = temporaryProducerContext(MODEL_PRODUCER_DESCRIPTOR); cleanups.push(temp.cleanup);
  const llm = scriptedLlm(() => responseText([draft()]));
  const port = createModelProducerPort(temp.ctx, { llm });
  const event = { ...GRACE_EVENT, text: `Grace shared ${SECRET} and Authorization: Bearer ${"q".repeat(20)}`, subjects: [{ subject_id: GRACE, role: "from" as const, display_name: `Grace ${SECRET}` }] };
  const base = input([event]);
  const known = { claim_id: "01JCLAIM000000000000000001", subject: GRACE, predicate: "employment.role", object: `note ${SECRET}`, polarity: "positive" as const, confidence: 0.5 };
  const result = await port.produce({ ...base, context: { ...base.context, known_claims: [known] } });
  const prompt = sent(llm);
  expect(prompt).not.toContain(SECRET);
  expect(prompt).not.toContain("q".repeat(20));
  expect(result).toMatchObject({ status: "ok", usage: { calls: 1, redacted: { api_token: 3, bearer: 1 } } });
});

test("the v1 judge sees the scrubbed events, never the original secret", async () => {
  const seen: SystemOneRequest[] = [];
  const judge: SystemOnePort = {
    descriptor: validatePortDescriptor({ id: "test.systemone.scrub-v1", kind: "systemone", contract: "kizuki.systemone/v1", contract_minor: 0, supports: ["evaluate"], requires_lease: false, optional_package: null }),
    model_ref: "test-judge", async health() { return { status: "ready", detail: {} }; }, async close() {},
    async evaluate(request): Promise<SystemOneResponse> { seen.push(request); return { model: "test-judge", answers: { admit_0: { type: "noul", noul: 0.95 } }, usage: { input_tokens: 1, output_tokens: 1 } }; },
  };
  const temp = temporaryProducerContext(MODEL_PRODUCER_DESCRIPTOR); cleanups.push(temp.cleanup);
  const port = createModelProducerPort(temp.ctx, { llm: scriptedLlm(() => responseText([draft()])), systemone: judge });
  const event = { ...GRACE_EVENT, text: `Grace mentioned she now runs partnerships at Acme. ${SECRET}` };
  const result = await port.produce(input([event]));
  expect(result.status).toBe("ok");
  expect(seen).toHaveLength(1);
  expect(JSON.stringify(seen)).not.toContain(SECRET);
  expect(JSON.stringify(seen)).toContain("[redacted:api_token]");
});

test("a result whose redaction counts are not known kinds is not a usable result", () => {
  const good = { calls: 1, input_tokens: 1, output_tokens: 1, redacted: { pem: 1 } };
  const wire = (usage: unknown) => ({ status: "unavailable", reason: "unavailable", usage });
  expect(validateProduceResult(wire(good), "kizuki.producer/v1").usage_known).toBe(true);
  for (const redacted of [{ other: 1 }, { pem: 0 }, { pem: 1.5 }, "pem", []]) {
    expect(validateProduceResult(wire({ ...good, redacted }), "kizuki.producer/v1").usage_known).toBe(false);
  }
});
