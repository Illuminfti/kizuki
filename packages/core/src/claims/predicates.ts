export const PREDICATE_CARDINALITIES = ["single", "multi"] as const;
export type PredicateCardinality = (typeof PREDICATE_CARDINALITIES)[number];

export interface PredicateSpec {
  readonly id: string;
  readonly cardinality: PredicateCardinality;
  readonly value_kind: "string";
  readonly subject_kinds: readonly string[];
}

/**
 * Seed registry from RFC 0002 §5.6. Single-valued predicates conflict when
 * two live claims share a claim_key and their normalized objects differ.
 */
export const PREDICATE_REGISTRY: readonly PredicateSpec[] = [
  { id: "identity.display_name", cardinality: "single", value_kind: "string", subject_kinds: ["person", "org"] },
  { id: "identity.handle_on", cardinality: "multi", value_kind: "string", subject_kinds: ["person", "org"] },
  { id: "identity.same_as", cardinality: "multi", value_kind: "string", subject_kinds: ["person", "org", "project"] },
  { id: "contact.email", cardinality: "multi", value_kind: "string", subject_kinds: ["person", "org"] },
  { id: "contact.phone", cardinality: "multi", value_kind: "string", subject_kinds: ["person", "org"] },
  { id: "location.based_in", cardinality: "single", value_kind: "string", subject_kinds: ["person", "org"] },
  { id: "employment.works_at", cardinality: "single", value_kind: "string", subject_kinds: ["person"] },
  { id: "employment.role", cardinality: "single", value_kind: "string", subject_kinds: ["person"] },
  { id: "project.owns", cardinality: "multi", value_kind: "string", subject_kinds: ["person", "org"] },
  { id: "project.works_on", cardinality: "multi", value_kind: "string", subject_kinds: ["person"] },
  { id: "project.status", cardinality: "single", value_kind: "string", subject_kinds: ["project"] },
  { id: "commitment.owes", cardinality: "multi", value_kind: "string", subject_kinds: ["person"] },
  { id: "commitment.due", cardinality: "single", value_kind: "string", subject_kinds: ["person", "project"] },
  { id: "relation.knows", cardinality: "multi", value_kind: "string", subject_kinds: ["person"] },
  { id: "relation.reports_to", cardinality: "single", value_kind: "string", subject_kinds: ["person"] },
  { id: "preference.prefers", cardinality: "multi", value_kind: "string", subject_kinds: ["person"] },
  { id: "preference.avoids", cardinality: "multi", value_kind: "string", subject_kinds: ["person"] },
  { id: "taste.likes_style", cardinality: "multi", value_kind: "string", subject_kinds: ["person"] },
  { id: "decision.decided", cardinality: "multi", value_kind: "string", subject_kinds: ["person"] },
  { id: "decision.rejected", cardinality: "multi", value_kind: "string", subject_kinds: ["person"] },
  { id: "tool.uses", cardinality: "multi", value_kind: "string", subject_kinds: ["person"] },
  { id: "tool.abandoned", cardinality: "multi", value_kind: "string", subject_kinds: ["person"] },
  { id: "skill.has", cardinality: "multi", value_kind: "string", subject_kinds: ["person"] },
  { id: "health.metric", cardinality: "multi", value_kind: "string", subject_kinds: ["person"] },
  { id: "outcome.reached", cardinality: "multi", value_kind: "string", subject_kinds: ["person", "project"] },
  { id: "outcome.missed", cardinality: "multi", value_kind: "string", subject_kinds: ["person", "project"] },
];

const BY_ID = new Map(PREDICATE_REGISTRY.map((entry) => [entry.id, entry]));

export function predicateIds(): readonly string[] {
  return PREDICATE_REGISTRY.map((entry) => entry.id);
}

export function getPredicate(id: string): PredicateSpec | undefined {
  return BY_ID.get(id);
}

export function isRegisteredPredicate(id: string): boolean {
  return BY_ID.has(id);
}

export function isSingleValuedPredicate(id: string): boolean {
  return BY_ID.get(id)?.cardinality === "single";
}
