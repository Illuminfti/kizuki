import type { Database } from "bun:sqlite";
import { ClaimError, type ClaimErrorCode } from "../claims/errors";
import { rawSubjectNamespace, rawSubjectRefKey, type ClaimV2Assertion, type RawSubjectRef } from "../contracts/claim-v2";
import type { WorldEndpointKind, WorldRegistry, WorldVocabularySpec } from "../contracts/world-kinds";
import { activeWorldRegistry } from "../contracts/world-vocabulary";

export type WorldViolationCode = Extract<ClaimErrorCode, `world_${string}`>;

export interface WorldViolation {
  readonly code: WorldViolationCode;
  readonly detail: string;
}

/**
 * Classifications a batch has accepted but not yet stored, by endpoint. A
 * caller vetting several drafts before filing any of them threads one map
 * through every check, so the batch is judged as it will be stored.
 */
export type PendingClassifications = Map<string, Set<string>>;

const classifies = (semantic: ClaimV2Assertion): boolean =>
  semantic.predicate === "world.kind" && semantic.polarity === "positive" &&
  semantic.perspective.mode === "asserted" && semantic.object.kind === "vocabulary";

export function notePendingClassification(pending: PendingClassifications, semantic: ClaimV2Assertion): void {
  if (!classifies(semantic) || semantic.object.kind !== "vocabulary") return;
  const key = rawSubjectRefKey(semantic.subject);
  pending.set(key, (pending.get(key) ?? new Set()).add(semantic.object.ref.id));
}

/**
 * The endpoint kinds an endpoint is already classified as: live, positive,
 * asserted `world.kind` claims whose value is a registered kind. Classification
 * is claim-derived, so an unclassified endpoint yields an empty set.
 */
function knownEndpointKinds(
  db: Database,
  registry: WorldRegistry,
  ref: RawSubjectRef,
  pending: PendingClassifications | undefined,
): ReadonlySet<WorldEndpointKind> {
  const stored = db.query<{ vocabulary_id: string }, [string, string, string]>(
    `SELECT DISTINCT json_extract(c.payload,'$.object.ref.id') AS vocabulary_id
       FROM claim_v2_semantics c JOIN claims base USING(claim_id)
      WHERE c.predicate='world.kind' AND c.polarity='positive' AND c.subject_kind=? AND c.subject_id=?
        AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=?
        AND json_extract(c.payload,'$.perspective.mode')='asserted'
        AND base.status='live' AND base.is_world_typed=1`,
  ).all(ref.kind, ref.id, rawSubjectNamespace(ref));
  const known = new Set<WorldEndpointKind>();
  for (const id of [...stored.map(row => row.vocabulary_id), ...pending?.get(rawSubjectRefKey(ref)) ?? []]) {
    const kind = registry.kindByVocabularyId(id);
    if (kind !== undefined) known.add(kind.endpointKind);
  }
  return known;
}

/** The endpoint kinds a subject-valued object may have, or null when the row places no constraint. */
function objectEndpointKinds(spec: WorldVocabularySpec): ReadonlySet<WorldEndpointKind> | null {
  return spec.objects.includes("raw_subject") || !spec.objects.includes("concept") ? null : new Set<WorldEndpointKind>(["concept"]);
}

/**
 * Whether a world assertion has the shape its registry row declares. Rows
 * are checked in one fixed order so a refusal is deterministic. An endpoint
 * with no classification yet is accepted, in any order of arrival; only a
 * contradiction with a classification already known is refused, and that
 * includes a second `world.kind` that names a different endpoint kind. Predicates
 * outside the world vocabulary are not this check's concern.
 */
export function worldAssertionViolation(
  db: Database,
  semantic: ClaimV2Assertion,
  options: { readonly registry?: WorldRegistry; readonly pending?: PendingClassifications } = {},
): WorldViolation | null {
  const registry = options.registry ?? activeWorldRegistry();
  const spec = registry.spec(semantic.predicate);
  if (spec === undefined) return null;
  const objectKind = semantic.object.kind;
  const allowedObject = objectKind === "literal" ? spec.objects.includes("literal")
    : objectKind === "vocabulary" ? spec.objects.includes("vocabulary")
    : spec.objects.includes("concept") || spec.objects.includes("raw_subject");
  if (!allowedObject) return { code: "world_object_kind", detail: `${spec.predicate} does not take a ${objectKind} object` };
  if (semantic.object.kind === "vocabulary" && spec.vocabulary_values !== null && !spec.vocabulary_values.includes(semantic.object.ref.id)) {
    return { code: "world_vocabulary_value", detail: `${spec.predicate} does not accept that vocabulary value` };
  }
  if (!spec.polarity.includes(semantic.polarity)) {
    return { code: "world_polarity", detail: `${spec.predicate} does not accept ${semantic.polarity} polarity` };
  }
  if (classifies(semantic) && semantic.object.kind === "vocabulary") {
    const kind = registry.kindByVocabularyId(semantic.object.ref.id);
    if (kind !== undefined) {
      const known = knownEndpointKinds(db, registry, semantic.subject, options.pending);
      if (known.size > 0 && !known.has(kind.endpointKind)) {
        return { code: "world_endpoint_kind", detail: `${spec.predicate} subject is already classified as another kind` };
      }
    }
  }
  const endpoints = [
    { role: "subject", ref: semantic.subject, allowed: spec.subject === "raw" ? null : new Set<WorldEndpointKind>([spec.subject]) },
    ...semantic.object.kind === "subject" ? [{ role: "object", ref: semantic.object.ref, allowed: objectEndpointKinds(spec) }] : [],
  ];
  for (const { role, ref, allowed } of endpoints) {
    if (allowed === null) continue;
    const known = knownEndpointKinds(db, registry, ref, options.pending);
    if (known.size > 0 && ![...known].some(kind => allowed.has(kind))) {
      return { code: "world_endpoint_kind", detail: `${spec.predicate} ${role} is already classified as another kind` };
    }
  }
  return null;
}

/** The shared writer's check: a violation is a refusal with its deterministic code. */
export function validateWorldAssertionAgainstRegistry(db: Database, semantic: ClaimV2Assertion): void {
  const violation = worldAssertionViolation(db, semantic);
  if (violation !== null) throw new ClaimError(violation.code, violation.detail);
}
