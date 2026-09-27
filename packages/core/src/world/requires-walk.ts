import { isWorldVocabularyPredicate } from "../contracts/world-vocabulary";

/** The only relation this baseline treats as a dependency. */
export const REQUIRES_PREDICATE = "concept.requires" as const;

const MAX_FACTS = 32;
const MAX_WITNESSES = 8;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type RequiresPolarity = "positive" | "negative";

/** One already-authorized snapshot edge. Not a live query and not a rule program. */
export type RequiresFact = {
  readonly claim_id: string;
  readonly predicate: string;
  readonly polarity: RequiresPolarity;
  readonly dependent_id: string;
  readonly required_id: string;
  readonly event_ids: readonly string[];
};

export type RequiresBound = {
  readonly max_nodes: number;
  readonly max_depth: number;
};

export type RequiresWitness = {
  readonly claim_id: string;
  readonly event_ids: readonly string[];
};

export type RequiresDependent = {
  readonly id: string;
  readonly depth: number;
  readonly via: readonly RequiresWitness[];
};

export type RequiresImpact = {
  readonly changed_id: string;
  readonly predicate: typeof REQUIRES_PREDICATE;
  readonly current: readonly RequiresDependent[];
  readonly withdrawn: readonly RequiresDependent[];
  readonly truncated: boolean;
  readonly cycle: readonly string[] | null;
};

export class RequiresWalkError extends Error {
  readonly code:
    | "unknown_predicate"
    | "unsupported_operator"
    | "ambiguous"
    | "unsupported";

  constructor(code: RequiresWalkError["code"], message: string) {
    super(message);
    this.name = "RequiresWalkError";
    this.code = code;
  }
}

function refuse(code: RequiresWalkError["code"], message: string): never {
  throw new RequiresWalkError(code, message);
}

function identity(label: string, value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) {
    refuse("unsupported", `${label} is not a bounded identity`);
  }
  return value;
}

type Group = {
  dependent_id: string;
  witnesses: RequiresWitness[];
};

function indexOf(
  facts: readonly RequiresFact[],
  polarity: RequiresPolarity,
): Map<string, Group[]> {
  const grouped = new Map<string, Map<string, RequiresWitness[]>>();
  for (const fact of facts) {
    if (fact.polarity !== polarity) continue;
    const byDependent = grouped.get(fact.required_id) ?? new Map();
    const witnesses = byDependent.get(fact.dependent_id) ?? [];
    witnesses.push({
      claim_id: fact.claim_id,
      event_ids: [...fact.event_ids].sort(),
    });
    byDependent.set(fact.dependent_id, witnesses);
    grouped.set(fact.required_id, byDependent);
  }
  const out = new Map<string, Group[]>();
  for (const [required, dependents] of grouped) {
    out.set(
      required,
      [...dependents.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([dependent_id, witnesses]) => ({
          dependent_id,
          witnesses: [...witnesses].sort((left, right) =>
            left.claim_id.localeCompare(right.claim_id),
          ),
        })),
    );
  }
  return out;
}

function walk(
  edges: Map<string, Group[]>,
  root: string,
  bound: RequiresBound,
): {
  nodes: RequiresDependent[];
  truncated: boolean;
  cycle: readonly string[] | null;
} {
  const nodes: RequiresDependent[] = [];
  const seen = new Set<string>([root]);
  let truncated = false;
  let cycle: readonly string[] | null = null;
  const queue: {
    id: string;
    depth: number;
    via: RequiresWitness[];
    path: readonly string[];
  }[] = [{ id: root, depth: 0, via: [], path: [root] }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const children = edges.get(current.id) ?? [];
    if (current.depth >= bound.max_depth) {
      if (children.length > 0) truncated = true;
      continue;
    }
    for (const child of children) {
      if (current.path.includes(child.dependent_id)) {
        cycle ??= [...current.path, child.dependent_id];
        continue;
      }
      if (seen.has(child.dependent_id)) continue;
      if (nodes.length >= bound.max_nodes) {
        truncated = true;
        return { nodes, truncated, cycle };
      }
      seen.add(child.dependent_id);
      const via = [...current.via, ...child.witnesses];
      const node = {
        id: child.dependent_id,
        depth: current.depth + 1,
        via,
      };
      nodes.push(node);
      queue.push({
        id: child.dependent_id,
        depth: node.depth,
        via,
        path: [...current.path, child.dependent_id],
      });
    }
  }
  return { nodes, truncated, cycle };
}

/**
 * Answers what currently depends on a changed concept, and what a negative
 * `concept.requires` edge withdraws, over one caller-built snapshot.
 *
 * This is the native baseline. It does not query a vault, adopt an upstream
 * projection module, or register a serving tool.
 */
export function explainRequiresImpact(
  facts: readonly RequiresFact[],
  changedId: string,
  bound: RequiresBound,
): RequiresImpact {
  if (!Array.isArray(facts) || facts.length > MAX_FACTS) {
    refuse("unsupported", "facts must be a bounded snapshot");
  }
  if (
    bound === null ||
    typeof bound !== "object" ||
    !Number.isSafeInteger(bound.max_nodes) ||
    bound.max_nodes < 1 ||
    bound.max_nodes > 32 ||
    !Number.isSafeInteger(bound.max_depth) ||
    bound.max_depth < 1 ||
    bound.max_depth > 8
  ) {
    refuse("unsupported", "bound is outside 1..32 nodes and 1..8 depth");
  }

  const changed = identity("changed_id", changedId);
  const claims = new Set<string>();
  const pairs = new Map<string, RequiresPolarity>();
  for (const fact of facts) {
    if (
      fact === null ||
      typeof fact !== "object" ||
      typeof fact.predicate !== "string"
    ) {
      refuse("unsupported", "fact is not a requirement edge");
    }
    if (!isWorldVocabularyPredicate(fact.predicate)) {
      refuse("unknown_predicate", "predicate is not in the world vocabulary");
    }
    if (fact.predicate !== REQUIRES_PREDICATE) {
      refuse("unsupported_operator", "only concept.requires is a dependency");
    }
    if (fact.polarity !== "positive" && fact.polarity !== "negative") {
      refuse("unsupported", "polarity must be positive or negative");
    }
    const claimId = identity("claim_id", fact.claim_id);
    if (claims.has(claimId)) refuse("ambiguous", "claim identity is repeated");
    claims.add(claimId);
    const dependent = identity("dependent_id", fact.dependent_id);
    const required = identity("required_id", fact.required_id);
    if (
      !Array.isArray(fact.event_ids) ||
      fact.event_ids.length === 0 ||
      fact.event_ids.length > MAX_WITNESSES
    ) {
      refuse("unsupported", "each fact needs a bounded witness list");
    }
    for (const eventId of fact.event_ids) identity("event_id", eventId);
    const pair = `${dependent}\0${required}`;
    const prior = pairs.get(pair);
    if (prior !== undefined && prior !== fact.polarity) {
      refuse("ambiguous", "the same requirement has both polarities");
    }
    pairs.set(pair, fact.polarity);
  }

  const current = walk(indexOf(facts, "positive"), changed, bound);
  const withdrawn = walk(indexOf(facts, "negative"), changed, bound);
  if (
    current.nodes.some((node) =>
      withdrawn.nodes.some((other) => other.id === node.id),
    )
  ) {
    refuse(
      "ambiguous",
      "one concept is both a current and a withdrawn dependent",
    );
  }

  return {
    changed_id: changed,
    predicate: REQUIRES_PREDICATE,
    current: current.nodes,
    withdrawn: withdrawn.nodes,
    truncated: current.truncated || withdrawn.truncated,
    cycle: current.cycle ?? withdrawn.cycle,
  };
}
