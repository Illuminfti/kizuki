import { createWorldRegistry, type WorldRegistry, type WorldVocabularyModule, type WorldVocabularySpec } from "./world-kinds";
import { CONCEPT_VOCABULARY } from "./world-vocab/concept";
import { LEARNING_VOCABULARY } from "./world-vocab/learning";
import { SITUATION_VOCABULARY } from "./world-vocab/situation";

export type { WorldEndpointKind, WorldObjectKind, WorldVocabularySpec } from "./world-kinds";

export const WORLD_VOCABULARY_SCHEMA = "kizuki.world-vocabulary/v1" as const;

/** Predicates are data once kinds register them, so the name is a plain string. */
export type WorldVocabularyPredicate = string;

/**
 * Every vocabulary module, in the order its rows reach the extraction prompt.
 * A workstream adds one line under its own marker; nothing scans a directory.
 */
export const WORLD_VOCABULARY_MODULES: readonly WorldVocabularyModule[] = [
  SITUATION_VOCABULARY,
  CONCEPT_VOCABULARY,
  LEARNING_VOCABULARY,
  // slot: quest
  // slot: people
  // slot: skill
  // slot: sit2
  // slot: art
  // slot: ident
];

export const WORLD_REGISTRY: WorldRegistry = createWorldRegistry(WORLD_VOCABULARY_MODULES);

export const WORLD_VOCABULARY: readonly WorldVocabularySpec[] = WORLD_REGISTRY.vocabulary;

export const WORLD_VOCABULARY_PREDICATES: readonly WorldVocabularyPredicate[] = Object.freeze(
  WORLD_VOCABULARY.map(spec => spec.predicate),
);

let active: WorldRegistry = WORLD_REGISTRY;

/** The registry every write, read and prompt consults. */
export function activeWorldRegistry(): WorldRegistry {
  return active;
}

let swapping = false;

/**
 * TEST ONLY. Runs `fn` with another registry, for a kind that exists only in
 * a test, and restores the shipped one when it settles. It swaps a
 * process-global registry, so it refuses to nest or overlap: a second swap
 * while one is in flight throws instead of leaving a test registry active.
 * Production code never calls it, and it is not part of the package surface.
 */
export function withWorldRegistry<T>(registry: WorldRegistry, fn: () => T): T {
  if (swapping) throw new Error("withWorldRegistry cannot nest or overlap");
  const previous = active;
  active = registry;
  swapping = true;
  const restore = () => { active = previous; swapping = false; };
  let result: T;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result instanceof Promise) return result.finally(restore) as T;
  restore();
  return result;
}

export function getWorldVocabularySpec(predicate: string): WorldVocabularySpec | undefined {
  return active.spec(predicate);
}

export function isWorldVocabularyPredicate(predicate: string): predicate is WorldVocabularyPredicate {
  return active.spec(predicate) !== undefined;
}
