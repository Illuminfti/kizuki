import type { SourceRef, ScopedRef } from "../../contracts/scoped-refs";
import { authorizedEventSql } from "../policy-sql";
import { allocateRef, readableEvent, ref, type RefScope } from "./common";

export type SourceTarget = { readonly sourceKey: string; readonly captureEventId: null } | { readonly sourceKey: null; readonly captureEventId: string };
/** A source is discoverable only through currently readable evidence. An
 * unbound historical capture gets an event-local locator, never source authority. */
export function issueSourceRef(scope: RefScope, eventId: string): SourceRef | null {
  if (!readableEvent(scope, eventId)) return null;
  const { ctx, ns } = scope;
  const bound = ctx.db.query<{ source_key: string }, [string]>("SELECT source_key FROM source_event_bindings WHERE event_id=?").get(eventId);
  const source = bound?.source_key ?? null, capture = bound === null ? eventId : null;
  const existing = ctx.db.query<{ wire_ref: string }, [string, string | null, string | null]>("SELECT wire_ref FROM world_wire_source_targets WHERE namespace_id=? AND source_key IS ? AND capture_event_id IS ?").get(ns.id, source, capture);
  if (existing !== null) return ref("source", existing.wire_ref);
  const token = allocateRef(ctx.db, ns, "source");
  ctx.db.query("INSERT INTO world_wire_source_targets(namespace_id,wire_ref,source_key,capture_event_id) VALUES (?,?,?,?)").run(ns.id, token, source, capture);
  return ref("source", token);
}
export function resolveSourceRef(scope: RefScope, value: ScopedRef): SourceTarget | null {
  if (value.kind !== "source") return null;
  const { ctx, ns } = scope;
  const row = ctx.db.query<{ source_key: string | null; capture_event_id: string | null }, [string, string]>("SELECT source_key,capture_event_id FROM world_wire_source_targets WHERE namespace_id=? AND wire_ref=?").get(ns.id, value.token);
  if (row === null) return null;
  if (row.capture_event_id !== null) return readableEvent(scope, row.capture_event_id) ? { sourceKey: null, captureEventId: row.capture_event_id } : null;
  if (row.source_key === null) return null;
  // Selection must be scoped before its bound. The shared SQL policy is the
  // source authority check; the event grant check below covers subject/time/type.
  const policy = authorizedEventSql(ctx);
  const visible = ctx.db.query<{ event_id: string }, (string | number)[]>(`SELECT events.event_id FROM events WHERE events.event_id IN (SELECT event_id FROM source_event_bindings WHERE source_key=?) AND ${policy.clauses.join(" AND ")} ORDER BY events.event_id LIMIT 1`).get(row.source_key, ...policy.bindings);
  return visible !== null && readableEvent(scope, visible.event_id) ? { sourceKey: row.source_key, captureEventId: null } : null;
}
