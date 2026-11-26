import { rawSubjectNamespace } from "../../contracts/claim-v2";
import { anchorOf, type Collector } from "../pipeline/collect";
import { collectEndpointStatements, personStatements } from "./person";

/** The seven typed extraction kinds beyond the baseline concept, situation, and artifact_version kinds. */
export const TYPED_EXTRACTION_KINDS = [
  "person",
  "question",
  "procedure",
  "skill",
  "framework",
  "commitment",
  "decision",
] as const;

export type TypedExtractionKind = (typeof TYPED_EXTRACTION_KINDS)[number];

/** All ten registered world kinds in Kizuki. */
export const ALL_WORLD_KINDS = [
  "concept",
  "situation",
  "artifact_version",
  ...TYPED_EXTRACTION_KINDS,
] as const;

export type WorldKindId = (typeof ALL_WORLD_KINDS)[number];

type TypedContextKind = Exclude<TypedExtractionKind, "person">;

const CONTEXT_ENDPOINT_SQL = `EXISTS(SELECT 1 FROM json_each(c.payload,'$.context') ctx_ref
  JOIN json_each(?) anchor
    ON json_extract(ctx_ref.value,'$.kind')=json_extract(anchor.value,'$.kind')
   AND json_extract(ctx_ref.value,'$.id')=json_extract(anchor.value,'$.id')
   AND coalesce(json_extract(ctx_ref.value,'$.namespace'),'')=json_extract(anchor.value,'$.namespace'))`;

/**
 * Collects authorized, unheld, time-valid assertions whose `$.context` references
 * any member of `cluster` for one typed extraction kind, reusing the shared
 * endpoint query and overflow bound from `person.ts`.
 */
export function contextStatementsFor(kindId: TypedContextKind): Collector {
  return (frame, cluster, kind) => {
    if (kind.id !== kindId) return [];
    const anchors = cluster.members
      .map((handle) => anchorOf(frame.ctx.db, handle))
      .filter((ref): ref is NonNullable<typeof ref> => ref !== null)
      .map((ref) => ({ kind: ref.kind, id: ref.id, namespace: rawSubjectNamespace(ref) }));
    if (anchors.length === 0) return [];
    return collectEndpointStatements(frame, CONTEXT_ENDPOINT_SQL, [JSON.stringify(anchors)]);
  };
}

export const questionStatements: Collector = contextStatementsFor("question");
export const procedureStatements: Collector = contextStatementsFor("procedure");
export const skillStatements: Collector = contextStatementsFor("skill");
export const frameworkStatements: Collector = contextStatementsFor("framework");
export const commitmentStatements: Collector = contextStatementsFor("commitment");
export const decisionStatements: Collector = contextStatementsFor("decision");

export const TYPED_KIND_COLLECTORS: Readonly<Record<TypedExtractionKind, Collector>> = Object.freeze({
  person: personStatements,
  question: questionStatements,
  procedure: procedureStatements,
  skill: skillStatements,
  framework: frameworkStatements,
  commitment: commitmentStatements,
  decision: decisionStatements,
});

/** Unified collector registered in `COLLECTORS` covering all seven typed extraction kinds. */
export const typedKindStatements: Collector = (frame, cluster, kind) => {
  const collector = TYPED_KIND_COLLECTORS[kind.id as TypedExtractionKind];
  return collector === undefined ? [] : collector(frame, cluster, kind);
};
