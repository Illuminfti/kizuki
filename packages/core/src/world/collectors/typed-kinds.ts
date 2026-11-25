import { rawSubjectNamespace } from "../../contracts/claim-v2";
import { authorizedClaimSql } from "../policy-sql";
import { knownPermittedAndUnheldSql, knownValidSql, WorldHistoryUnavailable } from "../known/cutoff";
import { anchorOf, type Collector } from "../pipeline/collect";
import { claimVisibleSql } from "../pipeline/frame";
import { personStatements } from "./person";

/** The seven typed extraction kinds qualified beyond the baseline concept, situation, and artifact_version kinds. */
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

const MAX_CONTEXT_CLAIMS = 129;

/**
 * Collects authorized, unheld, time-valid assertions whose `$.context` references
 * any member of `cluster` for one typed extraction kind. Historical reads verify
 * `claim_history_coverage` under current permission so erased older context cannot
 * read as absence.
 */
export function contextStatementsFor(kindId: TypedContextKind): Collector {
  return (frame, cluster, kind) => {
    if (kind.id !== kindId) return [];
    const anchors = cluster.members
      .map((handle) => anchorOf(frame.ctx.db, handle))
      .filter((ref): ref is NonNullable<typeof ref> => ref !== null)
      .map((ref) => ({ kind: ref.kind, id: ref.id, namespace: rawSubjectNamespace(ref) }));
    if (anchors.length === 0) return [];
    const cutoff = frame.cutoff.kind === "current" ? undefined : frame.cutoff;
    const claim = authorizedClaimSql(frame.ctx);
    const anchorsJson = JSON.stringify(anchors);
    const endpoint = `EXISTS(SELECT 1 FROM json_each(c.payload,'$.context') ctx_ref
      JOIN json_each(?) anchor
        ON json_extract(ctx_ref.value,'$.kind')=json_extract(anchor.value,'$.kind')
       AND json_extract(ctx_ref.value,'$.id')=json_extract(anchor.value,'$.id')
       AND coalesce(json_extract(ctx_ref.value,'$.namespace'),'')=json_extract(anchor.value,'$.namespace'))`;
    const scope = (historical: boolean) => {
      const admitted = knownPermittedAndUnheldSql(frame.ctx, "base", historical ? cutoff : undefined);
      return {
        sql: `FROM claim_v2_semantics c JOIN claims base USING(claim_id)
          WHERE c.discriminator='assertion' AND ${historical ? claimVisibleSql(frame, "base") : "base.status<>'purged'"}
          AND ${endpoint} AND ${claim.sql}
          AND ${admitted.sql}`,
        bindings: [anchorsJson, ...claim.bindings, ...admitted.bindings],
      };
    };
    if (cutoff !== undefined) {
      const current = scope(false);
      const unavailable = frame.ctx.db.query(`SELECT 1 ${current.sql} AND (
        NOT EXISTS(SELECT 1 FROM claim_history_coverage h WHERE h.claim_id=c.claim_id)
        OR EXISTS(SELECT 1 FROM claim_history_coverage h WHERE h.claim_id=c.claim_id AND h.coverage='baseline_only' AND h.complete_from_sequence>?)) LIMIT 1`)
        .get(...current.bindings, cutoff.sequence);
      if (unavailable !== null) throw new WorldHistoryUnavailable();
      if (frame.ctx.db.query(`SELECT 1 ${current.sql} AND EXISTS(SELECT 1 FROM claim_history_coverage h WHERE h.claim_id=c.claim_id AND h.coverage='baseline_only') LIMIT 1`).get(...current.bindings) !== null)
        frame.historyBaseline = true;
    }
    const selected = scope(true), valid = knownValidSql(frame.valid, cutoff);
    return frame.ctx.db.query<{ claim_id: string }, (string | number)[]>(
      `SELECT c.claim_id ${selected.sql} AND ${valid.sql} ORDER BY c.claim_id LIMIT ${MAX_CONTEXT_CLAIMS}`,
    ).all(...selected.bindings, ...valid.bindings).map((row) => row.claim_id);
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

/** Unified collector covering all seven typed extraction kinds beyond baseline concepts and situations. */
export const typedKindStatements: Collector = (frame, cluster, kind) => {
  const collector = TYPED_KIND_COLLECTORS[kind.id as TypedExtractionKind];
  return collector === undefined ? [] : collector(frame, cluster, kind);
};
