import type { OntologyRelation, OntologyTerm } from "./types";

/**
 * Pure TypeScript port of NVIDIA Auto-Ontology's `detect_term_families`:
 * detects prefix/namespace/versioned twin clusters (e.g. `OLD_*`/`NEW_*`,
 * `V1_*`/`V2_*`, `legacy_*`/`current_*`) using prefix stripping, attribute
 * Jaccard similarity, mirrored edge evidence, and same-prefix transitive
 * expansion that never bleeds across shared hub entities.
 */

export const MIN_TWIN_JACCARD = 0.8;
export const MIN_EDGE_TWIN_JACCARD = 0.5;
export const MIN_PAIR_EVIDENCE = 3;
export const DEFAULT_HISTORY_TOKENS: ReadonlySet<string> = new Set([
  "HIST",
  "HISTORY",
  "ARCHIVE",
]);

export interface TermFamilyCandidate {
  readonly entityId: string;
  readonly domain: string;
  readonly name: string;
  readonly termId: string;
  readonly attributes: readonly string[];
}

export interface TermFamilyEdge {
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly sourceAttribute: string;
  readonly targetAttribute: string;
}

export interface DetectTermFamiliesOptions {
  readonly minTwinJaccard?: number | undefined;
  readonly minEdgeTwinJaccard?: number | undefined;
  readonly minPairEvidence?: number | undefined;
  readonly historyTokens?: ReadonlySet<string> | undefined;
}

export interface DetectedTermFamily {
  readonly familyId: string;
  readonly domain: string;
  readonly prefix: string;
  readonly members: Record<string, string>;
  readonly twins: number;
  readonly expanded: number;
  readonly mirroredEdges: number;
}

interface IndexedEntity {
  readonly id: string;
  readonly domain: string;
  readonly name: string;
  readonly prefix: string;
  readonly base: string;
  readonly attributes: ReadonlySet<string>;
  readonly isHistory: boolean;
  readonly termIds: string[];
}

function tokenizeName(name: string): string[] {
  return name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token.length > 0);
}

export function stripLeadingPrefix(name: string, prefix: string): string {
  const upper = name.toUpperCase();
  const lead = `${prefix.toUpperCase()}_`;
  return upper.startsWith(lead) && upper !== lead
    ? upper.slice(lead.length)
    : upper;
}

export function attributeJaccard(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function edgeSignatureKey(
  baseA: string,
  attrA: string,
  baseB: string,
  attrB: string,
): string {
  const endA = `${baseA}::${attrA}`;
  const endB = `${baseB}::${attrB}`;
  return endA <= endB ? `${endA}|${endB}` : `${endB}|${endA}`;
}

function parseSignatureBases(sig: string): [string, string] {
  const sepIdx = sig.indexOf("|");
  const left = sig.slice(0, sepIdx);
  const right = sig.slice(sepIdx + 1);
  const leftBase = left.slice(0, left.indexOf("::"));
  const rightBase = right.slice(0, right.indexOf("::"));
  return [leftBase, rightBase];
}

function indexCandidates(
  candidates: readonly TermFamilyCandidate[],
  historyTokens: ReadonlySet<string>,
): Map<string, IndexedEntity> {
  const entities = new Map<string, IndexedEntity>();
  for (const row of candidates) {
    const existing = entities.get(row.entityId);
    if (existing !== undefined) {
      if (!existing.termIds.includes(row.termId)) {
        existing.termIds.push(row.termId);
      }
      continue;
    }
    const tokens = tokenizeName(row.name);
    if (tokens.length < 2) continue;
    const prefix = tokens[0];
    const lastToken = tokens[tokens.length - 1];
    if (prefix === undefined || lastToken === undefined) continue;
    const base = tokens.slice(1).join("_");
    const attrs = new Set<string>();
    for (const rawAttr of row.attributes) {
      const trimmed = rawAttr.trim();
      if (trimmed.length > 0) {
        attrs.add(stripLeadingPrefix(trimmed, prefix));
      }
    }
    entities.set(row.entityId, {
      id: row.entityId,
      domain: row.domain,
      name: row.name,
      prefix,
      base,
      attributes: attrs,
      isHistory: historyTokens.has(lastToken),
      termIds: [row.termId],
    });
  }
  return entities;
}

function confirmPrefixPair(
  leftByBase: ReadonlyMap<string, IndexedEntity>,
  rightByBase: ReadonlyMap<string, IndexedEntity>,
  sharedSignatures: ReadonlySet<string>,
  minTwinJaccard: number,
  minEdgeTwinJaccard: number,
  minPairEvidence: number,
): { twins: string[]; mirrored: number } | null {
  const edgeBases = new Set<string>();
  for (const sig of sharedSignatures) {
    const [b1, b2] = parseSignatureBases(sig);
    edgeBases.add(b1);
    edgeBases.add(b2);
  }

  const sharedBases: string[] = [];
  for (const base of leftByBase.keys()) {
    if (rightByBase.has(base)) sharedBases.push(base);
  }
  sharedBases.sort();

  const twins: string[] = [];
  for (const base of sharedBases) {
    const left = leftByBase.get(base);
    const right = rightByBase.get(base);
    if (left === undefined || right === undefined) continue;
    if (left.isHistory || right.isHistory) continue;
    const threshold = edgeBases.has(base) ? minEdgeTwinJaccard : minTwinJaccard;
    if (attributeJaccard(left.attributes, right.attributes) >= threshold) {
      twins.push(base);
    }
  }

  const twinSet = new Set(twins);
  let mirrored = 0;
  for (const sig of sharedSignatures) {
    const [b1, b2] = parseSignatureBases(sig);
    if (twinSet.has(b1) && twinSet.has(b2)) {
      mirrored += 1;
    }
  }

  if (twins.length + mirrored < minPairEvidence) {
    return null;
  }
  return { twins, mirrored };
}

function expandSamePrefix(
  seeds: ReadonlySet<string>,
  neighbours: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const found = new Set<string>(seeds);
  const frontier: string[] = [...seeds];
  while (frontier.length > 0) {
    const current = frontier.pop();
    if (current === undefined) break;
    const adj = neighbours.get(current);
    if (adj === undefined) continue;
    for (const next of adj) {
      if (!found.has(next)) {
        found.add(next);
        frontier.push(next);
      }
    }
  }
  return found;
}

export function detectTermFamilies(
  candidates: readonly TermFamilyCandidate[],
  edges: readonly TermFamilyEdge[],
  options: DetectTermFamiliesOptions = {},
): DetectedTermFamily[] {
  const minTwinJaccard = options.minTwinJaccard ?? MIN_TWIN_JACCARD;
  const minEdgeTwinJaccard = options.minEdgeTwinJaccard ?? MIN_EDGE_TWIN_JACCARD;
  const minPairEvidence = options.minPairEvidence ?? MIN_PAIR_EVIDENCE;
  const historyTokens = options.historyTokens ?? DEFAULT_HISTORY_TOKENS;

  const entities = indexCandidates(candidates, historyTokens);

  const byPrefix = new Map<string, Map<string, IndexedEntity>>();
  const signatures = new Map<string, Set<string>>();
  const neighbours = new Map<string, Set<string>>();
  const prefixesByDomain = new Map<string, Set<string>>();

  const prefixKey = (domain: string, prefix: string): string =>
    `${domain}\u0000${prefix}`;

  for (const entity of entities.values()) {
    const pKey = prefixKey(entity.domain, entity.prefix);
    let baseMap = byPrefix.get(pKey);
    if (baseMap === undefined) {
      baseMap = new Map<string, IndexedEntity>();
      byPrefix.set(pKey, baseMap);
    }
    if (!baseMap.has(entity.base)) {
      baseMap.set(entity.base, entity);
    }
    let domainPrefixes = prefixesByDomain.get(entity.domain);
    if (domainPrefixes === undefined) {
      domainPrefixes = new Set<string>();
      prefixesByDomain.set(entity.domain, domainPrefixes);
    }
    domainPrefixes.add(entity.prefix);
  }

  for (const edge of edges) {
    const a = entities.get(edge.sourceEntityId);
    const b = entities.get(edge.targetEntityId);
    if (a === undefined || b === undefined) continue;
    if (a.id === b.id || a.domain !== b.domain) continue;
    // Only connect edges within the same prefix so transitive expansion never
    // traverses through shared cross-prefix hub entities.
    if (a.prefix !== b.prefix) continue;

    let adjA = neighbours.get(a.id);
    if (adjA === undefined) {
      adjA = new Set<string>();
      neighbours.set(a.id, adjA);
    }
    adjA.add(b.id);

    let adjB = neighbours.get(b.id);
    if (adjB === undefined) {
      adjB = new Set<string>();
      neighbours.set(b.id, adjB);
    }
    adjB.add(a.id);

    const pKey = prefixKey(a.domain, a.prefix);
    let sigSet = signatures.get(pKey);
    if (sigSet === undefined) {
      sigSet = new Set<string>();
      signatures.set(pKey, sigSet);
    }
    sigSet.add(
      edgeSignatureKey(
        a.base,
        stripLeadingPrefix(edge.sourceAttribute, a.prefix),
        b.base,
        stripLeadingPrefix(edge.targetAttribute, b.prefix),
      ),
    );
  }

  const confirmedMembers = new Map<string, Map<string, IndexedEntity>>();
  const mirroredCounts = new Map<string, number>();

  const sortedDomains = [...prefixesByDomain.keys()].sort();
  for (const domain of sortedDomains) {
    const prefixes = [...(prefixesByDomain.get(domain) ?? [])].sort();
    for (let i = 0; i < prefixes.length; i += 1) {
      const p = prefixes[i];
      if (p === undefined) continue;
      for (let j = i + 1; j < prefixes.length; j += 1) {
        const q = prefixes[j];
        if (q === undefined) continue;
        const keyP = prefixKey(domain, p);
        const keyQ = prefixKey(domain, q);
        const mapP = byPrefix.get(keyP);
        const mapQ = byPrefix.get(keyQ);
        if (mapP === undefined || mapQ === undefined) continue;

        const sigP = signatures.get(keyP) ?? new Set<string>();
        const sigQ = signatures.get(keyQ) ?? new Set<string>();
        const sharedSigs = new Set<string>();
        for (const sig of sigP) {
          if (sigQ.has(sig)) sharedSigs.add(sig);
        }

        const confirmed = confirmPrefixPair(
          mapP,
          mapQ,
          sharedSigs,
          minTwinJaccard,
          minEdgeTwinJaccard,
          minPairEvidence,
        );
        if (confirmed === null) continue;

        let membersP = confirmedMembers.get(keyP);
        if (membersP === undefined) {
          membersP = new Map<string, IndexedEntity>();
          confirmedMembers.set(keyP, membersP);
        }
        let membersQ = confirmedMembers.get(keyQ);
        if (membersQ === undefined) {
          membersQ = new Map<string, IndexedEntity>();
          confirmedMembers.set(keyQ, membersQ);
        }

        for (const base of confirmed.twins) {
          const entP = mapP.get(base);
          const entQ = mapQ.get(base);
          if (entP !== undefined) membersP.set(base, entP);
          if (entQ !== undefined) membersQ.set(base, entQ);
        }
        mirroredCounts.set(keyP, (mirroredCounts.get(keyP) ?? 0) + confirmed.mirrored);
        mirroredCounts.set(keyQ, (mirroredCounts.get(keyQ) ?? 0) + confirmed.mirrored);
      }
    }
  }

  const families: DetectedTermFamily[] = [];
  const assignedTerms = new Set<string>();
  const sortedConfirmedKeys = [...confirmedMembers.keys()].sort();

  for (const key of sortedConfirmedKeys) {
    const sepIdx = key.indexOf("\u0000");
    const domain = key.slice(0, sepIdx);
    const prefix = key.slice(sepIdx + 1);
    const seedMap = confirmedMembers.get(key);
    if (seedMap === undefined) continue;

    const twinIds = new Set<string>();
    for (const ent of seedMap.values()) twinIds.add(ent.id);

    const memberIds = expandSamePrefix(twinIds, neighbours);
    const sortedMemberIds = [...memberIds].sort((a, b) => {
      const entA = entities.get(a);
      const entB = entities.get(b);
      return (entA?.name ?? a).localeCompare(entB?.name ?? b);
    });

    const members: Record<string, string> = {};
    for (const entityId of sortedMemberIds) {
      const entity = entities.get(entityId);
      if (entity === undefined) continue;
      for (const termId of entity.termIds) {
        if (assignedTerms.has(termId)) continue;
        assignedTerms.add(termId);
        members[termId] = entity.base;
      }
    }

    families.push({
      familyId: `fam:${domain.toLowerCase()}:${prefix.toLowerCase()}`,
      domain,
      prefix,
      members,
      twins: twinIds.size,
      expanded: memberIds.size - twinIds.size,
      mirroredEdges: mirroredCounts.get(key) ?? 0,
    });
  }

  return families;
}

/**
 * Convenience adapter that runs `detectTermFamilies` directly on compiled
 * `OntologyTerm[]` and `OntologyRelation[]`.
 */
export function detectTermFamiliesFromOntology(
  terms: readonly OntologyTerm[],
  relations: readonly OntologyRelation[],
  options: DetectTermFamiliesOptions = {},
): DetectedTermFamily[] {
  const candidates: TermFamilyCandidate[] = terms.map((term) => ({
    entityId: term.termId,
    domain: term.domain,
    name: term.canonicalName,
    termId: term.termId,
    attributes: term.attributes.map((attr) => attr.name),
  }));

  const edges: TermFamilyEdge[] = relations.map((rel) => ({
    sourceEntityId: rel.sourceTermId,
    targetEntityId: rel.targetTermId,
    sourceAttribute: rel.relationKind,
    targetAttribute: rel.relationKind,
  }));

  return detectTermFamilies(candidates, edges, options);
}
