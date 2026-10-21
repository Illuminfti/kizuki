import { heldClaimSql } from "../corroboration";
import type { Database } from "bun:sqlite";
import { instantBoundPair, instantPairSql } from "../../query/sql";
import type { ServeContext } from "../../serving/types";
import type { WorldValidQuery } from "../ops/types";
import { authorizedSupportSql, validMeaningSql } from "../policy-sql";

/** Private committed position. Never include it in wire bodies or fingerprints. */
export type KnownCutoff = { readonly at: string; readonly sequence: number };
export class WorldHistoryUnavailable extends Error {}

export function resolveKnownTime(db: Database, at: string): KnownCutoff {
  const row = db.query<{ recorded_at: string; sequence: number }, (string | number)[]>(
    `SELECT recorded_at,sequence FROM claim_lifecycle_history WHERE ${instantPairSql("recorded_at")} <= (?,?) ORDER BY sequence DESC LIMIT 1`,
  ).get(...instantBoundPair(at, "knownAt"));
  return row === null ? { at, sequence: 0 } : { at: row.recorded_at, sequence: row.sequence };
}

/** Only internally resolved safe integers are interpolated into these SQL fragments. */
export function cutoffSequence(cutoff: KnownCutoff): number {
  if (!Number.isSafeInteger(cutoff.sequence) || cutoff.sequence < 0) throw new WorldHistoryUnavailable();
  return cutoff.sequence;
}
export function lastStateSql(cutoff: KnownCutoff, claim = "base.claim_id", field = "after_status"): string {
  if (!["after_status", "valid_to"].includes(field)) throw new Error("invalid history field");
  return `(SELECT kh.${field} FROM claim_lifecycle_history kh WHERE kh.claim_id=${claim} AND kh.sequence<=${cutoffSequence(cutoff)} ORDER BY kh.sequence DESC LIMIT 1)`;
}
export function supportAtSql(cutoff: KnownCutoff, alias = "s"): string {
  const sequence = cutoffSequence(cutoff);
  // A retained upgrade/erasure baseline witnesses all supports still present at
  // that boundary. Later admissions need their own recorded support position.
  return `(EXISTS(SELECT 1 FROM claim_lifecycle_history kh WHERE kh.support_key=${alias}.support_key AND kh.sequence<=${sequence})
    OR EXISTS(SELECT 1 FROM claim_history_coverage kc WHERE kc.claim_id=${alias}.claim_id AND kc.coverage='baseline_only'
      AND kc.complete_from_sequence<=${sequence} AND NOT EXISTS(SELECT 1 FROM claim_lifecycle_history later WHERE later.support_key=${alias}.support_key)))`;
}
export function knownSupportSql(ctx: ServeContext, cutoff?: KnownCutoff): { sql: string; bindings: (string | number)[] } {
  const permitted = authorizedSupportSql(ctx);
  return cutoff === undefined ? permitted : { ...permitted, sql: `(${permitted.sql}) AND ${supportAtSql(cutoff)}` };
}
export function knownValidSql(valid: WorldValidQuery, cutoff?: KnownCutoff, alias = "c") {
  const rule = validMeaningSql(valid, alias);
  return cutoff === undefined ? rule : { ...rule, sql: rule.sql.replaceAll(`${alias}.valid_to`, lastStateSql(cutoff, `${alias}.claim_id`, "valid_to")) };
}
export function knownState(db: Database, claimId: string, cutoff: KnownCutoff) {
  return db.query<{ after_status: string; valid_to: string | null }, [string, number]>(
    "SELECT after_status,valid_to FROM claim_lifecycle_history WHERE claim_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 1",
  ).get(claimId, cutoffSequence(cutoff));
}

/** The past cannot borrow future corroboration or bypass a hold imposed today. */
export function knownHeldSql(ctx: ServeContext, alias: string, cutoff?: KnownCutoff) {
  const current = heldClaimSql(alias, knownSupportSql(ctx));
  if (cutoff === undefined) return current;
  const historical = heldClaimSql(alias, knownSupportSql(ctx, cutoff));
  return { sql: `(${current.sql} OR ${historical.sql})`, bindings: [...current.bindings, ...historical.bindings] };
}
