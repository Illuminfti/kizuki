import type { PageRef, ScopedRef } from "../../contracts/scoped-refs";
import { eventIdFromReference } from "../../retrieval/ids";
import { eligible, loadCanon, pageDecision, type CanonIndex } from "../../serving/canon";
import { stringArray, type CanonPage } from "../../vault/pages";
import { allocateRef, ref, type RefScope } from "./common";

export function issuePageRef(scope: RefScope, pageId: string, index: CanonIndex = loadCanon(scope.ctx)): PageRef | null {
  const page = index.byId.get(pageId);
  if (page === undefined || !eligible(page) || !pageDecision(index, scope.ctx.principal.grant, page).allow) return null;
  const { ctx, ns } = scope;
  // An on-disk edit can invalidate a ref without any page_index write.
  ctx.db.query("DELETE FROM world_wire_page_targets WHERE namespace_id=? AND page_id=? AND (content_hash<>? OR rel_path<>?)").run(ns.id, page.id, page.contentHash, page.relPath);
  const existing = ctx.db.query<{ wire_ref: string }, [string, string, string]>("SELECT wire_ref FROM world_wire_page_targets WHERE namespace_id=? AND page_id=? AND content_hash=?").get(ns.id, page.id, page.contentHash);
  if (existing !== null) return ref("page", existing.wire_ref);
  const token = allocateRef(ctx.db, ns, "page");
  ctx.db.query("INSERT INTO world_wire_page_targets(namespace_id,wire_ref,page_id,rel_path,content_hash) VALUES (?,?,?,?,?)").run(ns.id, token, page.id, page.relPath, page.contentHash);
  const insert = ctx.db.query("INSERT OR IGNORE INTO world_wire_page_events(namespace_id,wire_ref,event_id) VALUES (?,?,?)");
  for (const id of stringArray(page.data.sources).map(eventIdFromReference)) insert.run(ns.id, token, id);
  return ref("page", token);
}
export function resolvePageRef(scope: RefScope, value: ScopedRef, index: CanonIndex = loadCanon(scope.ctx)): CanonPage | null {
  if (value.kind !== "page") return null;
  const row = scope.ctx.db.query<{ page_id: string; rel_path: string; content_hash: string }, [string, string]>("SELECT page_id,rel_path,content_hash FROM world_wire_page_targets WHERE namespace_id=? AND wire_ref=?").get(scope.ns.id, value.token);
  if (row === null) return null;
  const page = index.byId.get(row.page_id);
  if (page === undefined || page.relPath !== row.rel_path || page.contentHash !== row.content_hash || !eligible(page)) {
    scope.ctx.db.query("DELETE FROM world_wire_page_targets WHERE namespace_id=? AND wire_ref=?").run(scope.ns.id, value.token);
    return null;
  }
  return pageDecision(index, scope.ctx.principal.grant, page).allow ? page : null;
}
