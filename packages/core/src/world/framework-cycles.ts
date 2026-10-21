import type { Database } from "bun:sqlite";
import { rawSubjectRefKey, type ClaimV2Assertion, type RawSubjectRef } from "../contracts/claim-v2";
import { canonicalJson } from "../util/hash";
import { collectCard, COLLECTORS, anchorOf } from "./pipeline/collect";
import { group, GROUPERS } from "./pipeline/group";
import { activeWorldRegistry } from "../contracts/world-vocabulary";
import { WorldProjectionBudgetError, type ReadFrame } from "./pipeline/frame";

export class FrameworkCycleError extends Error { override name = "FrameworkCycleError"; }
const edge = (s: ClaimV2Assertion) => ["framework.includes", "framework.component"].includes(s.predicate) && s.polarity === "positive" && s.perspective.mode === "asserted" && s.object.kind === "subject";
/** Refuse a bounded traversal that would add a cycle; no hidden graph detail is returned. */
export function frameworkWriteCycle(db: Database, semantic: ClaimV2Assertion): boolean {
  if (!edge(semantic) || semantic.object.kind !== "subject") return false;
  const target = rawSubjectRefKey(semantic.subject), pending: RawSubjectRef[] = [semantic.object.ref], seen = new Set<string>();
  while (pending.length > 0) {
    const node = pending.pop()!, key = rawSubjectRefKey(node);
    if (key === target) return true;
    if (seen.has(key)) continue;
    seen.add(key); if (seen.size > 128) return true;
    const rows = db.query<{ payload: string }, [string, string, string]>(`SELECT c.payload FROM claim_v2_semantics c JOIN claims b USING(claim_id)
      WHERE b.status='live' AND b.is_world_typed=1 AND c.predicate IN ('framework.includes','framework.component') AND c.polarity='positive'
      AND c.subject_kind=? AND c.subject_id=? AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=?
      AND json_extract(c.payload,'$.perspective.mode')='asserted' ORDER BY c.claim_id LIMIT 129`).all(node.kind, node.id, node.kind === "supplied" && "namespace" in node ? canonicalJson(node.namespace) : "");
    if (rows.length > 128) return true;
    for (const row of rows) { const s = JSON.parse(row.payload) as ClaimV2Assertion; if (edge(s) && s.object.kind === "subject") pending.push(s.object.ref); }
  }
  return false;
}
/** Every edge on read passes the same policy, support and historical eligibility as the card. */
export function assertFrameworkAcyclic(frame: ReadFrame, handle: string): void {
  const visiting = new Set<string>(), visited = new Set<string>();
  const kind = activeWorldRegistry().kind("framework")!;
  function walk(id: string): void {
    if (visiting.has(id)) throw new FrameworkCycleError();
    if (visited.has(id)) return;
    if (visited.size + visiting.size >= 128) throw new WorldProjectionBudgetError();
    visiting.add(id);
    const collection = collectCard(frame, group(frame, id, GROUPERS), kind, COLLECTORS);
    if (collection?.overflow) throw new WorldProjectionBudgetError();
    const anchor = anchorOf(frame.ctx.db, id);
    for (const item of collection?.items ?? []) {
      const s = item.semantic;
      if (anchor === null || rawSubjectRefKey(s.subject) !== rawSubjectRefKey(anchor) || !edge(s) || s.object.kind !== "subject") continue;
      const ns = s.object.ref.kind === "supplied" && "namespace" in s.object.ref ? canonicalJson(s.object.ref.namespace) : "";
      const child = frame.ctx.db.query<{ handle_id: string }, [string,string,string]>("SELECT handle_id FROM semantic_bindings WHERE raw_kind=? AND raw_id=? AND raw_namespace=?").get(s.object.ref.kind,s.object.ref.id,ns);
      if (child !== null) walk(child.handle_id);
    }
    visiting.delete(id); visited.add(id);
  }
  walk(handle);
}
