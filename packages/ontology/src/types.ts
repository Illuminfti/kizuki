/**
 * Sensitivity lattice matching `@kizuki/core`:
 * `public < personal < private`.
 */
export const ONTOLOGY_SENSITIVITY_ORDER = {
  public: 0,
  personal: 1,
  private: 2,
} as const;

export type OntologySensitivity = keyof typeof ONTOLOGY_SENSITIVITY_ORDER;

export const ONTOLOGY_SENSITIVITIES = [
  "public",
  "personal",
  "private",
] as const;

export type OntologyCertification = "draft" | "certified";

export type OntologyTargetKind = "term" | "metric";

export type OntologyCertificationAction = "certify" | "uncertify" | "undo";

export function isOntologySensitivity(
  value: unknown,
): value is OntologySensitivity {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(ONTOLOGY_SENSITIVITY_ORDER, value)
  );
}

export function compareOntologySensitivity(
  left: OntologySensitivity,
  right: OntologySensitivity,
): number {
  return ONTOLOGY_SENSITIVITY_ORDER[left] - ONTOLOGY_SENSITIVITY_ORDER[right];
}

export function maxOntologySensitivity(
  left: OntologySensitivity,
  right: OntologySensitivity,
): OntologySensitivity {
  return ONTOLOGY_SENSITIVITY_ORDER[left] >= ONTOLOGY_SENSITIVITY_ORDER[right]
    ? left
    : right;
}

/**
 * Fail-closed sensitivity normalization. Unknown or absent labels default to
 * `private` (or the caller-supplied fallback if valid).
 */
export function normalizeOntologySensitivity(
  value: unknown,
  fallback: OntologySensitivity = "private",
): OntologySensitivity {
  if (isOntologySensitivity(value)) return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (isOntologySensitivity(lowered)) return lowered;
  }
  return fallback;
}

/**
 * Fail-closed ceiling check: returns true only when both values are valid
 * sensitivity levels and `itemSens <= ceiling`.
 */
export function withinOntologySensitivity(
  itemSens: OntologySensitivity | string,
  ceiling: OntologySensitivity | string,
): boolean {
  if (!isOntologySensitivity(itemSens) || !isOntologySensitivity(ceiling)) {
    return false;
  }
  return ONTOLOGY_SENSITIVITY_ORDER[itemSens] <= ONTOLOGY_SENSITIVITY_ORDER[ceiling];
}

export function allowedOntologySensitivities(
  ceiling: OntologySensitivity,
): OntologySensitivity[] {
  const rank = ONTOLOGY_SENSITIVITY_ORDER[ceiling];
  return ONTOLOGY_SENSITIVITIES.filter(
    (level) => ONTOLOGY_SENSITIVITY_ORDER[level] <= rank,
  );
}

export interface OntologyAttribute {
  name: string;
  kind?: string;
  description?: string;
  values?: string[];
}

export interface OntologyTerm {
  termId: string;
  canonicalName: string;
  normalizedKey: string;
  kind: string;
  domain: string;
  description: string;
  synonyms: string[];
  subjects: string[];
  attributes: OntologyAttribute[];
  provenance: string[];
  sensitivity: OntologySensitivity;
  evidenceCount: number;
  certification: OntologyCertification;
  certifiedBy: string | null;
  certifiedAt: string | null;
  familyId: string | null;
  updatedAt: string;
}

export interface OntologyTermFamily {
  familyId: string;
  prefix: string;
  domain: string;
  members: Record<string, string>;
  twinCount: number;
  mirroredEdgeCount: number;
  updatedAt: string;
}

export interface OntologyRelation {
  relationId: string;
  sourceTermId: string;
  targetTermId: string;
  relationKind: string;
  evidenceCount: number;
  confidence: number;
  isDefaultJoin: boolean;
  supportRefs: string[];
  sensitivity: OntologySensitivity;
  updatedAt: string;
}

export interface OntologyMetric {
  metricId: string;
  name: string;
  termId: string | null;
  description: string;
  expression: string;
  grain: string;
  certification: OntologyCertification;
  sensitivity: OntologySensitivity;
  updatedAt: string;
}

export interface OntologyCertificationReceipt {
  receiptId: string;
  targetKind: OntologyTargetKind;
  targetId: string;
  action: OntologyCertificationAction;
  actor: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: string;
}

export interface OntologyStatus {
  dbPath: string;
  termCount: number;
  certifiedTermCount: number;
  draftTermCount: number;
  familyCount: number;
  relationCount: number;
  defaultJoinCount: number;
  metricCount: number;
  certifiedMetricCount: number;
  certificationReceiptCount: number;
  lastCompiledAt: string | null;
  schemaVersion: string;
}

export interface OntologyScopeOptions {
  readonly sensitivityCeiling?: OntologySensitivity | undefined;
  readonly allowedSubjects?: readonly string[] | null | undefined;
}

/**
 * Deterministic key normalization for canonical term lookup and deduplication.
 */
export function normalizeTermKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const NAMESPACED_SUBJECT_RE = /^[a-z][a-z0-9_-]*:.+/;

/**
 * Returns true when `value` is an explicit namespaced subject identifier such
 * as `person:atlas` or `project:atlas` (excluding synthetic `term:` keys).
 */
export function isNamespacedSubjectId(value: string): boolean {
  const trimmed = value.trim();
  return NAMESPACED_SUBJECT_RE.test(trimmed) && !/^term:/i.test(trimmed);
}

/**
 * Fail-closed exact subject scope matching against provenance-backed subject
 * identities (`term.subjects`), matching Core authorization semantics.
 * - `allowedSubjects === undefined || allowedSubjects === null`: unrestricted.
 * - Empty array `[]`: denies everything.
 * - Non-empty array: term must carry at least one exact subject in `allowedSubjects`.
 */
export function termMatchesAllowedSubjects(
  term: Pick<OntologyTerm, "subjects">,
  allowedSubjects: readonly string[] | null | undefined,
): boolean {
  if (allowedSubjects === undefined || allowedSubjects === null) {
    return true;
  }
  if (allowedSubjects.length === 0) {
    return false;
  }
  if (term.subjects.length === 0) {
    return false;
  }
  const allowedSet = new Set(allowedSubjects);
  return term.subjects.some((subject) => allowedSet.has(subject));
}

export function normalizeAttributes(
  input: readonly (string | OntologyAttribute)[] | undefined,
): OntologyAttribute[] {
  if (!input || input.length === 0) return [];
  const byName = new Map<string, OntologyAttribute>();
  for (const item of input) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length === 0) continue;
      const key = trimmed.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, { name: trimmed });
      }
      continue;
    }
    const trimmed = item.name.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    const existing = byName.get(key);
    const mergedValues = new Set<string>([
      ...(existing?.values ?? []),
      ...(item.values ?? []).map((v) => v.trim()).filter((v) => v.length > 0),
    ]);
    const attr: OntologyAttribute = { name: existing?.name ?? trimmed };
    const kind = item.kind ?? existing?.kind;
    if (kind !== undefined && kind.trim().length > 0) attr.kind = kind.trim();
    const description = item.description ?? existing?.description;
    if (description !== undefined && description.trim().length > 0) {
      attr.description = description.trim();
    }
    if (mergedValues.size > 0) {
      attr.values = [...mergedValues].sort();
    }
    byName.set(key, attr);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function dedupeStrings(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
