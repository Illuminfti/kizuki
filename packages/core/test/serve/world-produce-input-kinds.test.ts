import { expect, test } from "bun:test";
import { createWorldRegistry, worldPredicate } from "../../src/contracts/world-kinds";
import { WORLD_VOCABULARY_MODULES, withWorldRegistry } from "../../src/contracts/world-vocabulary";
import { planModelExtractionV2 } from "../../src/producer/model-v2";
import { worldProduceInput } from "../../src/serve/extract-v2";
import { DEFAULT_EXTRACTION_CONFIG } from "../../src/serve/types";
import { canonicalJson, sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";
import { testKind } from "../helpers/world-kinds";

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

test("every planned kind offered at once still fits the extraction input ceiling", () => {
  const planned = ["question", "person", "skill", "framework", "procedure", "commitment", "decision", "artifact_version", "outcome", "forecast"];
  const registry = createWorldRegistry([
    ...WORLD_VOCABULARY_MODULES,
    ...planned.map(id => testKind(id, { offeredToProducer: true }, ["text", "status", "about", "evidence", "step", "owner"].map(
      field => worldPredicate({ predicate: `${id}.${field}`, subject: "concept", objects: ["literal"] })))),
  ]);
  const plan = withWorldRegistry(registry, () => planModelExtractionV2(
    worldProduceInput([{ event_id: ulid(), text: "x".repeat(12_000) } as never], [], DEFAULT_EXTRACTION_CONFIG),
  ));
  expect(plan.status).toBe("ready");
  if (plan.status === "ready") expect(plan.input_tokens).toBeLessThanOrEqual(DEFAULT_EXTRACTION_CONFIG.max_input_tokens);
});
