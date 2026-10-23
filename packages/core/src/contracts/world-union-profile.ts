import { createWorldRegistry, type WorldRegistry, type WorldVocabularyModule } from "./world-kinds";

/** Canonical active union composition; its construction is not qualification evidence. */
export const WORLD_UNION_CANDIDATE_KINDS = Object.freeze([
  "concept", "situation", "question", "person", "skill", "framework", "procedure", "commitment", "decision",
] as const);
export const WORLD_UNION_CANDIDATE_EXTENSIONS = Object.freeze(["situation.has_commitment"] as const);

/**
 * Explicit build-owned opt-in. Both qualification and a later accepted product
 * activation use these same registered modules and order. Merely importing or
 * constructing this profile never changes the active registry or source grants.
 */
export function createWorldUnionCandidateRegistry(modules: readonly WorldVocabularyModule[]): WorldRegistry {
  const kinds: readonly string[] = WORLD_UNION_CANDIDATE_KINDS;
  const extensions: readonly string[] = WORLD_UNION_CANDIDATE_EXTENSIONS;
  if (kinds.some(id => !modules.some(module => module.kind?.id === id)) ||
      extensions.some(id => !modules.some(module => module.kind === null && module.predicates[0]?.predicate === id)))
    throw new Error("union producer profile requires the registered kinds and extensions");
  return createWorldRegistry(modules.map(module => module.kind !== null
    ? kinds.includes(module.kind.id) ? { ...module, kind: { ...module.kind, offeredToProducer: true } } : module
    : extensions.includes(module.predicates[0]?.predicate ?? "") ? { ...module, offeredToProducer: true } : module));
}
