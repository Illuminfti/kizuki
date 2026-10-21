import { expect, test } from "bun:test";
import { planModelExtractionV2 } from "../../src/producer/model-v2";
import { worldProduceInput } from "../../src/serve/extract-v2";
import { DEFAULT_EXTRACTION_CONFIG } from "../../src/serve/types";
import { canonicalJson, sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";

test("the model input for the shipped kinds is byte-identical to the pinned prompt surface", () => {
  const input = worldProduceInput([], [], DEFAULT_EXTRACTION_CONFIG);
  expect(sha256Hex(canonicalJson(input))).toBe("45463cb9551a4bf1f00aa5d9379b9ec950e9aa14c4637fd418a9f32461ca9542");
  expect(input.vocabulary_refs).toEqual(["learning/assisted", "learning/unassisted", "world/concept", "world/situation"]);
  expect(input.predicates).toHaveLength(49);
});

test("the shipped model input leaves most of the extraction budget to the records", () => {
  const plan = planModelExtractionV2(worldProduceInput([{ event_id: ulid(), text: "x".repeat(10) } as never], [], DEFAULT_EXTRACTION_CONFIG));
  expect(plan.status).toBe("ready");
});
