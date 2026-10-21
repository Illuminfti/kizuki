import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { resolvePrincipal } from "../../agents";
import { parseScopedRef, type ScopedRef, type ScopedRefKind } from "../../contracts/scoped-refs";
import { eventDecision, readServableEvents } from "../../serving/ledger";
import { ServeError, type ServeContext } from "../../serving/types";
import { issuedOpaqueFields } from "../../util/issued-opaque";
import { authorizedEventSql } from "../policy-sql";
import { worldNamespace, type WorldNamespace } from "../references";

export type RefScope = { readonly ctx: ServeContext; readonly ns: WorldNamespace };
/** Call only inside the existing gate/publication transaction, with current authority. */
export function referenceScope(ctx: ServeContext): RefScope {
  if (!ctx.db.inTransaction) throw new Error("scoped reference access requires a transaction");
  const principal = resolvePrincipal(ctx.db, ctx.principal);
  if (principal === null) throw new ServeError("unknown_agent", "unknown agent");
  return { ctx: { ...ctx, principal }, ns: worldNamespace(ctx.db, principal) };
}
export function requireScopedRef(value: unknown): ScopedRef {
  const parsed = parseScopedRef(value);
  if (parsed === null) throw new ServeError("invalid_arguments", "invalid arguments: reference must be a typed token");
  return parsed;
}
export const missingReference = (): ServeError => new ServeError("not_found", "not found");
export function ref<K extends ScopedRefKind>(kind: K, token: string): ScopedRef<K> {
  return issuedOpaqueFields({ kind, token }, ["token"]);
}
/** Allocates identity only. The caller inserts its authorized typed target in the same transaction. */
export function allocateRef(db: Database, ns: WorldNamespace, kind: ScopedRefKind): string {
  if (!db.inTransaction) throw new Error("scoped reference issuance requires a transaction");
  let token: string;
  do { token = randomBytes(32).toString("base64url"); }
  while (db.query("SELECT 1 FROM world_wire_refs WHERE namespace_id=? AND wire_ref=?").get(ns.id, token) !== null);
  db.query("INSERT INTO world_wire_refs(namespace_id,wire_ref,ref_kind) VALUES (?,?,?)").run(ns.id, token, kind);
  return token;
}
export function readableEvent(scope: RefScope, eventId: string): boolean {
  const policy = authorizedEventSql(scope.ctx);
  if (scope.ctx.db.query(`SELECT 1 FROM events WHERE event_id=? AND ${policy.clauses.join(" AND ")}`).get(eventId, ...policy.bindings) === null) return false;
  const event = readServableEvents(scope.ctx.db, [eventId]).get(eventId);
  return event !== undefined && eventDecision(scope.ctx.principal.grant, event, scope.ctx).allow;
}
