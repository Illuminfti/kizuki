import type { ScopedRef, ObservationRef } from "../../contracts/scoped-refs";
import { checkedObservation } from "../../claims/observations";
import type { KnownCutoff } from "../known/cutoff";
import { knownSupportSql } from "../known/cutoff";
import { allocateRef, readableEvent, ref, type RefScope } from "./common";

/** A durable selection is usable only while every original support event and
 * every exact event version remains readable. Token possession is immaterial. */
export function readableObservation(scope: RefScope, id: string, cutoff?: KnownCutoff) {
  const { ctx } = scope, policy = knownSupportSql(ctx, cutoff);
  if (ctx.db.query(`SELECT 1 FROM world_observations o JOIN claim_v2_support s USING(support_key)
    WHERE o.observation_id=? AND ${policy.sql}`).get(id, ...policy.bindings) === null) return null;
  const value = checkedObservation(ctx.db, id);
  if (value === null || cutoff !== undefined && value.record.recorded.admissionSeq > cutoff.sequence || value.events.some(id => !readableEvent(scope, id))) return null;
  return value;
}
export function resolveObservationRef(scope: RefScope, value: ScopedRef, cutoff?: KnownCutoff) {
  if (value.kind !== "observation" && value.kind !== "admission") return null;
  const row = value.kind === "observation"
    ? scope.ctx.db.query<{ observation_id: string }, [string, string]>("SELECT observation_id FROM world_wire_observation_targets WHERE namespace_id=? AND wire_ref=?").get(scope.ns.id, value.token)
    : scope.ctx.db.query<{ observation_id: string }, [string, string]>(`SELECT o.observation_id FROM world_wire_admission_targets a JOIN world_observations o USING(support_key) WHERE a.namespace_id=? AND a.wire_ref=?`).get(scope.ns.id, value.token);
  return row === null ? null : readableObservation(scope, row.observation_id, cutoff);
}
export function issueObservationRef(scope: RefScope, id: string): ObservationRef {
  const row = scope.ctx.db.query<{ wire_ref: string }, [string, string]>("SELECT wire_ref FROM world_wire_observation_targets WHERE namespace_id=? AND observation_id=?").get(scope.ns.id, id);
  if (row !== null) return ref("observation", row.wire_ref);
  const token = allocateRef(scope.ctx.db, scope.ns, "observation");
  scope.ctx.db.query("INSERT INTO world_wire_observation_targets(namespace_id,wire_ref,observation_id) VALUES (?,?,?)").run(scope.ns.id, token, id);
  return ref("observation", token);
}
