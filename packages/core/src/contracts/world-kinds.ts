import type { PageType } from "../vault/schema";

export type WorldEndpointKind = "raw" | "concept" | "situation" | "person" | "task_context";

export type WorldObjectKind = "literal" | "concept" | "raw_subject" | "vocabulary";

export type WorldPolarity = "positive" | "negative";

/** One predicate row of the world vocabulary: the shape its claims must have. */
export interface WorldVocabularySpec {
  readonly predicate: string;
  readonly subject: WorldEndpointKind;
  readonly objects: readonly WorldObjectKind[];
  readonly cardinality: "multi";
  readonly polarity: readonly WorldPolarity[];
  readonly max_literal_chars: number | null;
  readonly vocabulary_values: readonly string[] | null;
}

/**
 * How claims of a kind can come to exist. `extraction` is the typed model
 * producer, `owner_assertion` an owner statement through correction, and
 * `derived` a kind computed from other kinds. A kind whose only path is
 * `extraction` is empty by design while it is not offered to the producer.
 */
export type WorldKindPopulation = "extraction" | "owner_assertion" | "derived";

/** A kind of thing the world model can hold, as data with one registration site. */
export interface WorldKindSpec {
  readonly id: string;
  /** The `world.kind` object that classifies a subject as this kind. */
  readonly vocabularyId: string;
  readonly labelPredicate: string;
  /** Vault page type its canon page carries; a member of the closed page type set. */
  readonly pageType: PageType;
  readonly endpointKind: Exclude<WorldEndpointKind, "raw">;
  readonly cardSchema: string;
  /** Whether the extraction model is told about this kind and its predicates. */
  readonly offeredToProducer: boolean;
  readonly population: readonly WorldKindPopulation[];
}

/**
 * The vocabulary one file contributes. A kind module owns a kind and its
 * predicates and is offered to the producer with that kind. A kindless module
 * adds predicates about other kinds and says for itself whether it is offered.
 */
export type WorldVocabularyModule =
  | { readonly kind: WorldKindSpec; readonly predicates: readonly WorldVocabularySpec[] }
  | { readonly kind: null; readonly offeredToProducer: boolean; readonly predicates: readonly WorldVocabularySpec[] };

const BOTH_POLARITIES = Object.freeze(["positive", "negative"] as const);
const LITERAL_MAX_CHARS = 400;

export interface WorldPredicateInput {
  readonly predicate: string;
  readonly subject: WorldEndpointKind;
  readonly objects: readonly WorldObjectKind[];
  readonly values?: readonly string[];
  readonly polarity?: readonly WorldPolarity[];
}

/** One frozen row, multi-valued and polarity-preserving unless the caller narrows it. */
export function worldPredicate(input: WorldPredicateInput): WorldVocabularySpec {
  return Object.freeze({
    predicate: input.predicate,
    subject: input.subject,
    objects: Object.freeze([...input.objects]),
    cardinality: "multi" as const,
    polarity: input.polarity === undefined ? BOTH_POLARITIES : Object.freeze([...input.polarity]),
    max_literal_chars: input.objects.includes("literal") ? LITERAL_MAX_CHARS : null,
    vocabulary_values: input.values === undefined ? null : Object.freeze([...input.values]),
  });
}

export interface WorldRegistry {
  readonly kinds: readonly WorldKindSpec[];
  /** Every row, `world.kind` first, in registration order. */
  readonly vocabulary: readonly WorldVocabularySpec[];
  /** The rows and trusted vocabulary ids the extraction model is shown. */
  readonly offered: { readonly vocabulary: readonly WorldVocabularySpec[]; readonly refs: readonly string[] };
  spec(predicate: string): WorldVocabularySpec | undefined;
  kind(id: string): WorldKindSpec | undefined;
  kindByVocabularyId(vocabularyId: string): WorldKindSpec | undefined;
  isLabelPredicate(predicate: string): boolean;
}

export const WORLD_KIND_PREDICATE = "world.kind";

function invalid(detail: string): never {
  throw new Error(`world registry: ${detail}`);
}

function unique<T>(what: string, values: readonly T[]): void {
  if (new Set(values).size !== values.length) invalid(`duplicate ${what}`);
}

/** Builds and checks the registry once, so a bad registration fails at load rather than at a write. */
export function createWorldRegistry(modules: readonly WorldVocabularyModule[]): WorldRegistry {
  const kinds = modules.flatMap(module => module.kind === null ? [] : [module.kind]);
  unique("kind id", kinds.map(kind => kind.id));
  unique("vocabulary id", kinds.map(kind => kind.vocabularyId));
  const rows = modules.flatMap(module => module.predicates);
  unique("predicate", rows.map(row => row.predicate));
  if (rows.some(row => row.predicate === WORLD_KIND_PREDICATE)) invalid(`${WORLD_KIND_PREDICATE} is derived from the kinds`);
  for (const module of modules) {
    if (module.kind === null) continue;
    const label = module.predicates.find(row => row.predicate === module.kind!.labelPredicate);
    if (label === undefined || label.subject !== module.kind.endpointKind || !label.objects.includes("literal")) {
      invalid(`kind ${module.kind.id} needs a literal label predicate on its own endpoint kind`);
    }
    if (!module.kind.vocabularyId.startsWith("world/")) invalid(`kind ${module.kind.id} vocabulary id must start with world/`);
  }
  const kindRow = (registered: readonly WorldKindSpec[]): WorldVocabularySpec => worldPredicate({
    predicate: WORLD_KIND_PREDICATE,
    subject: "raw",
    objects: ["vocabulary"],
    values: registered.map(kind => kind.vocabularyId).sort(),
  });
  const offeredModules = modules.filter(module => module.kind === null ? module.offeredToProducer : module.kind.offeredToProducer);
  const offeredKinds = kinds.filter(kind => kind.offeredToProducer);
  const offeredRows = [
    ...(offeredKinds.length === 0 ? [] : [kindRow(offeredKinds)]),
    ...offeredModules.flatMap(module => module.predicates),
  ];
  const vocabulary = [kindRow(kinds), ...rows];
  const bySpec = new Map(vocabulary.map(row => [row.predicate, row] as const));
  const byKind = new Map(kinds.map(kind => [kind.id, kind] as const));
  const byVocabularyId = new Map(kinds.map(kind => [kind.vocabularyId, kind] as const));
  const labels = new Set(kinds.map(kind => kind.labelPredicate));
  const registry: WorldRegistry = {
    kinds: Object.freeze([...kinds]),
    vocabulary: Object.freeze(vocabulary),
    offered: Object.freeze({
      vocabulary: Object.freeze(offeredRows),
      refs: Object.freeze([...new Set(offeredRows.flatMap(row => row.vocabulary_values ?? []))].sort()),
    }),
    spec: predicate => bySpec.get(predicate),
    kind: id => byKind.get(id),
    kindByVocabularyId: vocabularyId => byVocabularyId.get(vocabularyId),
    isLabelPredicate: predicate => labels.has(predicate),
  };
  return Object.freeze(registry);
}
