import type { Tool } from "../../agents";
import type { CorrectDataV2, ProposeDataV2, ReadGap } from "../../contracts/scoped-tools";
import { issueWorldRef } from "../../world/references";
import { allocateRef, ref, type RefScope } from "../../world/ref-kinds/common";
import { issueClaimGroupRef, issueClaimRef } from "../../world/ref-kinds/claim";
import { issuePageRef } from "../../world/ref-kinds/page";
import type { CorrectData } from "../correct";
import type { GraphData } from "../graph";
import { loadCanon } from "../canon";
import type { ProposeData } from "../propose";
import type { SearchData } from "../search";
import { ServeError } from "../types";

function mutationReceipt(scope: RefScope, id: string | null) {
  if (id === null || scope.ctx.db.query("SELECT 1 FROM canon_receipts WHERE receipt_id=? AND receipt_state<>'erased'").get(id) === null) return null;
  const existing = scope.ctx.db.query<{ wire_ref: string }, [string, string]>("SELECT wire_ref FROM world_wire_receipt_targets WHERE namespace_id=? AND receipt_id=?").get(scope.ns.id, id);
  if (existing !== null) return ref("receipt", existing.wire_ref);
  // The mutation just authorized this attribution. It grants no future receipt,
  // page or evidence access; resolvers always apply current read policy.
  const token = allocateRef(scope.ctx.db, scope.ns, "receipt");
  scope.ctx.db.query("INSERT INTO world_wire_receipt_targets(namespace_id,wire_ref,receipt_id) VALUES (?,?,?)").run(scope.ns.id, token, id);
  return ref("receipt", token);
}
function correction(scope: RefScope, data: CorrectData): CorrectDataV2 {
  const index = data.rewritten.length === 0 ? null : loadCanon(scope.ctx);
  return {
    receipt: mutationReceipt(scope, data.receipt_id),
    eventVersion: data.event_id === null ? null : issueWorldRef(scope.ctx.db, scope.ns, "event_version", data.event_id),
    claim: data.claim_id === null ? null : issueWorldRef(scope.ctx.db, scope.ns, "claim", data.claim_id),
    superseded: data.superseded.map(item => issueWorldRef(scope.ctx.db, scope.ns, "claim", item.claim_id)),
    rewritten: data.rewritten.flatMap(item => {
      const page = index?.byPath.get(item.page_path), value = page === undefined ? null : issuePageRef(scope, page.id, index!);
      return value === null ? [] : [{ page: value, diff: { status: "unavailable" as const } }];
    }),
    ambiguous: data.ambiguous.flatMap(item => {
      const candidate = issueClaimGroupRef(scope, item.claim_ids), claims = item.claim_ids.map(id => issueClaimRef(scope, id));
      return candidate === null || claims.some(value => value === null) ? [] : [{ candidate, claims: claims.filter(value => value !== null) }];
    }),
    message: data.event_id !== null || data.claim_id !== null ? "correction_recorded" : data.ambiguous.length > 0 ? "ambiguous" : data.answer.toLowerCase().includes("dry") ? "dry_run" : "no_change",
    refreshedWorld: data.refreshedWorld ?? null,
  };
}
/** Each tool owns a closed data DTO. Legacy answer strings, coverage ID maps,
 * frontmatter and unified diffs are never copied into the scoped wire shape. */
export function projectToolData(scope: RefScope, tool: Tool, data: unknown): unknown {
  switch (tool) {
    case "get_page": case "query_entities": case "timeline": return null;
    case "search": {
      const reasons = (data as SearchData | undefined)?.degraded ?? [];
      const gaps = new Set<ReadGap>();
      for (const reason of reasons) {
        if (reason.includes("retrieval")) gaps.add("retrieval_unavailable");
        else if (reason === "scan-bound") gaps.add("budget");
        else if (reason.startsWith("index-") || reason.includes("unavailable")) gaps.add("coverage");
      }
      return { gaps: [...gaps] };
    }
    case "graph_neighbors": {
      const scoped = (data as GraphData).scoped;
      if (scoped === undefined) throw new ServeError("error", "serving failed");
      return { anchor: scoped.anchor, edges: scoped.edges, truncated: scoped.truncated };
    }
    case "propose": {
      const result = data as ProposeData;
      return { outcome: result.outcome, claim: issueWorldRef(scope.ctx.db, scope.ns, "claim", result.claim_id),
        superseded: result.superseded.map(id => issueWorldRef(scope.ctx.db, scope.ns, "claim", id)) } satisfies ProposeDataV2;
    }
    case "correct": return correction(scope, data as CorrectData);
    case "context_packet": case "world_view": return data;
    case "system_health": throw new ServeError("unsupported_contract", "requested contract unavailable");
  }
}
