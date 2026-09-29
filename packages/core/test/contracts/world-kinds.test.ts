import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PAGE_TYPES } from "../../src/vault/schema";
import { createWorldRegistry, worldPredicate } from "../../src/contracts/world-kinds";
import { testKind } from "../helpers/world-kinds";
import {
  WORLD_REGISTRY,
  WORLD_VOCABULARY_MODULES,
  activeWorldRegistry,
  getWorldVocabularySpec,
  withWorldRegistry,
} from "../../src/contracts/world-vocabulary";

describe("the shipped kinds", () => {
  test("concept and situation are registered with their page types, labels and cards", () => {
    expect(WORLD_REGISTRY.kinds.map(kind => kind.id)).toEqual(["situation", "concept"]);
    expect(WORLD_REGISTRY.kind("concept")).toMatchObject({
      vocabularyId: "world/concept", labelPredicate: "concept.label", pageType: "topic", endpointKind: "concept",
      cardSchema: "kizuki.concept-card/v1", offeredToProducer: true, population: ["extraction"],
    });
    expect(WORLD_REGISTRY.kindByVocabularyId("world/situation")).toMatchObject({
      id: "situation", labelPredicate: "situation.label", pageType: "project", endpointKind: "situation",
      cardSchema: "kizuki.situation-card/v1", offeredToProducer: true,
    });
    expect(WORLD_REGISTRY.kindByVocabularyId("world/person")).toBeUndefined();
  });

  test("every kind names a page type from the closed set, and every offered row is a registered row", () => {
    for (const kind of WORLD_REGISTRY.kinds) expect(PAGE_TYPES as readonly string[]).toContain(kind.pageType);
    for (const row of WORLD_REGISTRY.offered.vocabulary) expect(WORLD_REGISTRY.spec(row.predicate)).toEqual(row);
  });

  test("world.kind is derived from the kinds, so a kind cannot exist without its classification value", () => {
    expect(getWorldVocabularySpec("world.kind")?.vocabulary_values).toEqual(["world/concept", "world/situation"]);
  });

  test("every registration slot appears exactly once in the module list", () => {
    const source = readFileSync(new URL("../../src/contracts/world-vocabulary.ts", import.meta.url), "utf8");
    for (const key of ["quest", "people", "skill", "sit2", "art", "ident"]) {
      expect(source.match(new RegExp(`// slot: ${key}$`, "gm"))).toHaveLength(1);
    }
    expect(WORLD_VOCABULARY_MODULES).toHaveLength(3);
  });
});

describe("registration is checked once, at load", () => {
  test("rejects duplicate kinds, duplicate predicates and a hand-written world.kind", () => {
    const [situation] = WORLD_VOCABULARY_MODULES;
    expect(() => createWorldRegistry([situation!, situation!])).toThrow("duplicate kind id");
    expect(() => createWorldRegistry([testKind("a"), testKind("b", { labelPredicate: "a.label" }, [])])).toThrow("literal label predicate");
    expect(() => createWorldRegistry([testKind("a", {}, [worldPredicate({ predicate: "a.label", subject: "concept", objects: ["literal"] })])]))
      .toThrow("duplicate predicate");
    expect(() => createWorldRegistry([testKind("a", {}, [worldPredicate({ predicate: "world.kind", subject: "raw", objects: ["vocabulary"] })])]))
      .toThrow("derived from the kinds");
    expect(() => createWorldRegistry([testKind("a", { vocabularyId: "elsewhere/a" })])).toThrow("must start with world/");
  });
});

describe("offering a kind to the extraction model", () => {
  const dark = testKind("ghost");
  const lit = testKind("ghost", { offeredToProducer: true });

  test("a kind that is not offered adds no predicate and no vocabulary id", () => {
    const shipped = createWorldRegistry(WORLD_VOCABULARY_MODULES);
    const registry = createWorldRegistry([...WORLD_VOCABULARY_MODULES, dark]);
    expect(registry.offered).toEqual(shipped.offered);
    expect(registry.spec("ghost.label")).toBeDefined();
    expect(registry.spec("world.kind")?.vocabulary_values).toContain("world/ghost");
  });

  test("flipping the flag adds exactly that kind's predicates and its classification id", () => {
    const before = createWorldRegistry([...WORLD_VOCABULARY_MODULES, dark]).offered;
    const after = createWorldRegistry([...WORLD_VOCABULARY_MODULES, lit]).offered;
    expect(after.vocabulary.map(row => row.predicate).filter(id => !before.vocabulary.some(row => row.predicate === id))).toEqual(["ghost.label"]);
    expect(after.refs.filter(id => !before.refs.includes(id))).toEqual(["world/ghost"]);
  });

  test("nothing is offered as a world.kind when no kind is offered", () => {
    const registry = createWorldRegistry([dark]);
    expect(registry.offered.vocabulary).toEqual([]);
    expect(registry.offered.refs).toEqual([]);
  });
});

test("the test seam swaps the registry only while it runs, including when it throws", async () => {
  const other = createWorldRegistry([testKind("ghost", { offeredToProducer: true })]);
  expect(withWorldRegistry(other, () => activeWorldRegistry().kind("ghost")?.id)).toBe("ghost");
  expect(activeWorldRegistry()).toBe(WORLD_REGISTRY);
  expect(() => withWorldRegistry(other, () => { throw new Error("boom"); })).toThrow("boom");
  expect(activeWorldRegistry()).toBe(WORLD_REGISTRY);
  await withWorldRegistry(other, async () => { await Promise.resolve(); expect(activeWorldRegistry()).toBe(other); });
  expect(activeWorldRegistry()).toBe(WORLD_REGISTRY);
  await expect(withWorldRegistry(other, async () => { throw new Error("late"); })).rejects.toThrow("late");
  expect(activeWorldRegistry()).toBe(WORLD_REGISTRY);
});
