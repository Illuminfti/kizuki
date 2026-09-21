import { SENSITIVITY_ORDER } from "../agents";
import { LIVE_PREDICATE } from "../ledger/ledger";
import { sourceServingSql } from "../ledger/source-grants";
import { ceilingSql, instantBoundPair, instantPairSql } from "../query/sql";
import type { ServeContext } from "../serving/types";
import type { WorldValidQuery } from "../serving/world-view";

/** Push current policy before candidate/support LIMIT; Core still validates selected complete records. */
export function authorizedSupportSql(
  ctx: ServeContext,
  alias = "s",
): { sql: string; bindings: (string | number)[] } {
  const grant = ctx.principal.grant,
    bindings: (string | number)[] = [];
  const event = [LIVE_PREDICATE, ceilingSql("events.sensitivity_hint")];
  bindings.push(SENSITIVITY_ORDER[grant.ceiling]);
  const source = sourceServingSql(
    ctx.db,
    { owner: ctx.principal.kind === "owner", purpose: "recall" },
    SENSITIVITY_ORDER[grant.ceiling],
  );
  if (source !== null) {
    event.push(source.sql);
    bindings.push(...source.bindings);
  }
  if (grant.types !== null) {
    event.push("events.kind IN (SELECT value FROM json_each(?))");
    bindings.push(JSON.stringify(grant.types));
  }
  if (grant.subjects !== null) {
    event.push(
      "EXISTS(SELECT 1 FROM json_each(events.subjects) es WHERE json_extract(es.value,'$.subject_id') IN (SELECT value FROM json_each(?)))",
    );
    bindings.push(JSON.stringify(grant.subjects));
  }
  if (grant.since !== null) {
    event.push(`${instantPairSql("events.occurred_at")} >= (?,?)`);
    bindings.push(...instantBoundPair(grant.since, "since"));
  }
  if (grant.until !== null) {
    event.push(`${instantPairSql("events.occurred_at")} <= (?,?)`);
    bindings.push(...instantBoundPair(grant.until, "until"));
  }
  event.push(`(( ${alias}.support_origin='source' AND EXISTS(SELECT 1 FROM source_event_bindings b WHERE b.event_id=events.event_id AND b.source_key=${alias}.source_key)) OR
    (${alias}.support_origin='native_owner' AND ${ctx.principal.kind === "owner" || grant.relay_owner_corrections ? "1" : "0"} AND ${alias}.source_key='native-owner' AND ${alias}.grant_revision=0 AND
      NOT EXISTS(SELECT 1 FROM source_event_bindings b WHERE b.event_id=events.event_id) AND
      EXISTS(SELECT 1 FROM native_owner_evidence n WHERE n.event_id=events.event_id AND n.event_content_hash=events.content_hash
        AND n.origin='correction' AND events.origin_binding_kind='native' AND events.connector_id='kizuki.owner')))`);
  const clauses = [
    `length(${alias}.admission)<=524288 AND json_valid(${alias}.admission) AND json_extract(${alias}.admission,'$.schema')='kizuki.world-admission/v1'`,
    `EXISTS(SELECT 1 FROM claim_v2_support_events se WHERE se.support_key=${alias}.support_key)`,
    `NOT EXISTS(SELECT 1 FROM claim_v2_support_events se LEFT JOIN events ON events.event_id=se.event_id
      WHERE se.support_key=${alias}.support_key AND (events.event_id IS NULL OR events.content_hash<>se.event_content_hash OR COALESCE((${event.join(" AND ")}),0)=0))`,
  ];
  if (grant.subjects !== null) {
    clauses.push(`NOT EXISTS(SELECT 1 FROM semantic_allocations a JOIN semantic_bindings b USING(handle_id)
      WHERE a.support_key=${alias}.support_key AND b.raw_id NOT IN (SELECT value FROM json_each(?)))`);
    bindings.push(JSON.stringify(grant.subjects));
  }
  return { sql: clauses.join(" AND "), bindings };
}
export function validMeaningSql(
  valid: WorldValidQuery,
  alias = "c",
): { sql: string; bindings: (string | number)[] } {
  if (valid.kind === "all") return { sql: "1", bindings: [] };
  if (valid.kind === "unknown_only")
    return { sql: `${alias}.temporal_basis='unknown'`, bindings: [] };
  const from = instantPairSql(`${alias}.valid_from`),
    until = instantPairSql(`${alias}.valid_to`);
  if (valid.kind === "at")
    return {
      sql: `${alias}.temporal_basis<>'unknown' AND ${from}<=(?,?) AND (${alias}.valid_to IS NULL OR ${until}>(?,?))`,
      bindings: [
        ...instantBoundPair(valid.at, "at"),
        ...instantBoundPair(valid.at, "at"),
      ],
    };
  return {
    sql: `${alias}.temporal_basis<>'unknown' AND ${from}<(?,?) AND (${alias}.valid_to IS NULL OR ${until}>(?,?))`,
    bindings: [
      ...instantBoundPair(valid.until, "until"),
      ...instantBoundPair(valid.from, "from"),
    ],
  };
}
