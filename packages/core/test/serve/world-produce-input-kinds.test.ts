import { expect, test } from "bun:test";
import { createWorldRegistry, worldPredicate } from "../../src/contracts/world-kinds";
import { WORLD_VOCABULARY_MODULES, withWorldRegistry } from "../../src/contracts/world-vocabulary";
import { createModelProducerV2Port, MODEL_PRODUCER_V2_DESCRIPTOR, planModelExtractionV2 } from "../../src/producer/model-v2";
import { worldProduceInput } from "../../src/serve/extract-v2";
import { DEFAULT_EXTRACTION_CONFIG } from "../../src/serve/types";
import { canonicalJson, sha256Hex } from "../../src/util/hash";
import { CHARS_PER_TOKEN } from "../../src/producer/model";
import { ulid } from "../../src/util/ulid";
import { testKind } from "../helpers/world-kinds";
import { scriptedLlm, temporaryProducerContext } from "../producer/helpers";

const input = () => worldProduceInput([], [], DEFAULT_EXTRACTION_CONFIG);
const shipped = () => sha256Hex(canonicalJson(input()));
const ghost = (offeredToProducer: boolean) => createWorldRegistry([
  ...WORLD_VOCABULARY_MODULES,
  testKind("ghost", { offeredToProducer }, [worldPredicate({ predicate: "ghost.trait", subject: "concept", objects: ["literal"] })]),
]);

test("a kind that is not offered leaves the model input untouched", () => {
  const before = shipped();
  expect(withWorldRegistry(ghost(false), shipped)).toBe(before);
});

test("offering a kind adds exactly its predicates and its classification id", () => {
  const before = input();
  const after = withWorldRegistry(ghost(true), input);
  expect(after.predicates.filter(row => !before.predicates.some(prior => prior.id === row.id)).map(row => row.id)).toEqual(["ghost.label", "ghost.trait"]);
  expect(after.vocabulary_refs.filter(id => !before.vocabulary_refs.includes(id))).toEqual(["world/ghost"]);
  expect(after.predicates.slice(0, before.predicates.length)).toEqual([...before.predicates]);
});

test("every planned kind leaves room for record text within the extraction input ceiling", () => {
  const planned = ["question", "person", "skill", "framework", "procedure", "commitment", "decision", "artifact_version", "outcome", "forecast"];
  const registry = createWorldRegistry([
    ...WORLD_VOCABULARY_MODULES.map(module => module.kind !== null && planned.includes(module.kind.id)
      ? { ...module, kind: { ...module.kind, offeredToProducer: true } } : module),
    ...planned.filter(id => !WORLD_VOCABULARY_MODULES.some(module => module.kind?.id === id)).map(id => testKind(id, { offeredToProducer: true }, ["text", "status", "about", "evidence", "step", "owner"].map(
      field => worldPredicate({ predicate: `${id}.${field}`, subject: "concept", objects: ["literal"] })))),
  ]);
  withWorldRegistry(registry, () => {
    const event_id = ulid();
    const plan = (text: string) => planModelExtractionV2(worldProduceInput([{ event_id, text } as never], [], DEFAULT_EXTRACTION_CONFIG));
    const minimum = plan("x");
    expect(minimum.status).toBe("ready");
    if (minimum.status !== "ready") throw new Error("offered registry leaves no record budget");
    const recordChars = (DEFAULT_EXTRACTION_CONFIG.max_input_tokens - minimum.input_tokens) * CHARS_PER_TOKEN;
    expect(recordChars).toBeGreaterThan(0);
    const filled = plan("x".repeat(recordChars));
    expect(filled.status).toBe("ready");
    if (filled.status === "ready") expect(filled.input_tokens).toBeLessThanOrEqual(DEFAULT_EXTRACTION_CONFIG.max_input_tokens);
    expect(plan("x".repeat(recordChars + CHARS_PER_TOKEN * 2)).status).toBe("rejected");
  });
});

test("an identical offered predicate shares the legacy row and the actual typed producer accepts its claim", async () => {
  const modules = WORLD_VOCABULARY_MODULES.filter(module => !module.predicates.some(row => row.predicate === "commitment.due"));
  const registry = createWorldRegistry([...modules, { kind: null, offeredToProducer: true,
    predicates: [worldPredicate({ predicate: "commitment.due", subject: "raw", objects: ["literal"] })] }]);
  const event_id = ulid(), text = "C1 is due on 2026-02-06.", anchor = { event_id, start_utf16: 0, end_utf16: 2 };
  const request = withWorldRegistry(registry, () => worldProduceInput([{ event_id, text } as never], [{ id: "c1", anchors: [anchor] }]));
  expect(request.predicates.filter(row => row.id === "commitment.due")).toEqual([{ id: "commitment.due", object_kinds: ["literal"] }]);
  const temp = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR);
  const llm = scriptedLlm(() => JSON.stringify({ schema: "kizuki.producer-response/v2", mentions: [], claims: [{
    id: "due", subject: { kind: "supplied", id: "c1" }, predicate: "commitment.due", object: { kind: "literal", value: "2026-02-06" },
    perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] }, context: [],
    polarity: "positive", body: text, valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.8, sensitivity: "personal",
    anchors: [anchor, { event_id, start_utf16: 0, end_utf16: text.length }],
  }] }));
  const producer = createModelProducerV2Port(temp.ctx, { llm });
  try {
    const result = await producer.produce(request);
    expect(result).toMatchObject({ status: "ok", response: { claims: [{ predicate: "commitment.due" }] }, usage: { calls: 1 } });
    expect(result.status === "ok" ? result.dropped ?? [] : null).toEqual([]);
    expect(llm.requests).toHaveLength(1);
  } finally { await producer.close(); temp.cleanup(); }
});

test("a colliding predicate with an incompatible typed object shape refuses before a producer call", () => {
  const modules = WORLD_VOCABULARY_MODULES.filter(module => !module.predicates.some(row => row.predicate === "commitment.due"));
  const registry = createWorldRegistry([...modules, { kind: null, offeredToProducer: true,
    predicates: [worldPredicate({ predicate: "commitment.due", subject: "raw", objects: ["literal", "raw_subject"] })] }]);
  expect(() => withWorldRegistry(registry, input)).toThrow("incompatible producer predicate: commitment.due");
});
