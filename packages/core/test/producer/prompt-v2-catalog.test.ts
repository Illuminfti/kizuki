import { expect, test } from "bun:test";
import { createWorldRegistry } from "../../src/contracts/world-kinds";
import { WORLD_VOCABULARY_MODULES, withWorldRegistry } from "../../src/contracts/world-vocabulary";
import { extractionV2SystemContent } from "../../src/producer/prompt-v2";
import { worldProduceInput } from "../../src/serve/extract-v2";

const registry = createWorldRegistry(WORLD_VOCABULARY_MODULES.map(module => module.kind === null ? module :
  { ...module, kind: { ...module.kind, offeredToProducer: ["concept", "person", "question", "commitment", "decision"].includes(module.kind.id) } }));
const input = () => withWorldRegistry(registry, () => worldProduceInput([{ event_id: "00000000000000000000000001", text: "Synthetic subject." }] as never));
const catalog = (prompt: string) => JSON.parse(prompt.split("World contract (build-owned; only offered rows): ")[1]!.split("\n")[0]!);

test("offered model input contains the registered endpoint and value constraints, not a flat predicate bag", () => {
  const prompt = extractionV2SystemContent(input()), value = catalog(prompt);
  expect(value.kinds).toContainEqual(["person", "world/person", "person.label"]);
  expect(value.predicates).toContainEqual(["person.role", "person", ["literal"], null, ["positive", "negative"]]);
  expect(value.predicates).toContainEqual(["commitment.due", "commitment", ["literal"], null, ["positive", "negative"]]);
  expect(value.predicates).toContainEqual(["decision.status", "decision", ["vocabulary"], ["decision/open", "decision/decided", "decision/reversed"], ["positive", "negative"]]);
  expect(prompt).toContain("Person subjects require direct supplied refs");
  expect(prompt).toContain("ordinary mention nominations do not resolve identity");
  expect(prompt).not.toContain("rejects the whole response");
});

test("catalog does not reveal disabled kinds or unoffered predicate values", () => {
  const request = input();
  const prompt = extractionV2SystemContent({ ...request,
    predicates: request.predicates.filter(row => row.id !== "person.role"),
    vocabulary_refs: request.vocabulary_refs.filter(id => id !== "decision/reversed"),
  });
  const value = catalog(prompt);
  expect(value.kinds.some((row: string[]) => ["skill", "artifact_version"].includes(row[0]!))).toBe(false);
  expect(value.predicates.some((row: string[]) => row[0] === "person.role")).toBe(false);
  expect(value.predicates.find((row: string[]) => row[0] === "decision.status")[3]).toEqual(["decision/open", "decision/decided"]);
  expect(prompt).not.toContain('"artifact.original"');
});

test("the offered interest contract teaches the writer's hypothesis boundary and stays absent when unoffered", () => {
  const request = input(), prompt = extractionV2SystemContent(request);
  expect(catalog(prompt).predicates).toContainEqual(["person.interest", "person", ["concept"], null, ["positive", "negative"]]);
  expect(prompt).toContain('person.interest is a source-derived hypothesis');
  expect(prompt).toContain('mode uncertain and interpretation inferred');
  expect(prompt).toContain('never turn attention into a role, competence, or stable trait');
  const without = extractionV2SystemContent({ ...request, predicates: request.predicates.filter(row => row.id !== 'person.interest') });
  expect(without).not.toContain('person.interest is a source-derived hypothesis');
});
