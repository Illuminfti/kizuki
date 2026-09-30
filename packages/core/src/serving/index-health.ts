import { authorize, sensitivity, type Grant } from "../agents";
import { readDerivedMeta } from "../derived-meta";
import { sourceEventsAllowed, sourceSensitivity } from "../ledger/source-grants";
import { tableExists } from "../ledger/schema";
import { eventIdFromReference } from "../retrieval/ids";
import { timelineSelection } from "../query/timeline";
import type { ServeContext } from "./types";
import type { CanonPage } from "../vault/pages";
import { stringArray } from "../vault/pages";
import { assessLivePageEvidence, isDeterministicBrief, projectablePageEvidence } from "../vault/provenance";
import { eligible, pageDecision, pageServable, type CanonIndex } from "./canon";

/** Query health is a property of the caller's visible corpus, never a global stamp. */
export function visibleIndexDegraded(index: CanonIndex, grant: Grant, layer: "search" | "graph", pages: readonly CanonPage[] = index.pages): boolean {
  const ctx = index.sourceContext;
  const projectable = projectablePageEvidence(ctx.db, pages);
  const exists = layer === "search"
    ? tableExists(ctx.db, "search_documents") && tableExists(ctx.db, "search_docs")
    : tableExists(ctx.db, "graph_edges");
  for (const page of pages) {
    if (!eligible(page) || isDeterministicBrief(page)) continue;
    const sources = stringArray(page.data["sources"]).map(eventIdFromReference);
    const original = sensitivity(page.data["sensitivity"]);
    // Check policy before looking at failures. Unknown evidence is owner diagnostics only.
    if (!authorize(grant, { ...pageServable(index, page), held: false, sensitivity: original }).allow) continue;
    if (ctx.principal.kind !== "owner" && sources.length === 0) continue;
    if (!sourceEventsAllowed(ctx.db, sources, { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall" })) continue;
    if (original === null || !authorize(grant, { ...pageServable(index, page), held: false, sensitivity: sourceSensitivity(ctx.db, sources, original) }).allow) continue;
    const evidence = assessLivePageEvidence(ctx.db, page, undefined, { ...ctx, principal: { ...ctx.principal, grant } });
    if (!evidence.admitted && evidence.reason === "sources_unavailable" && ctx.principal.kind !== "owner") continue;
    if (!pageDecision(index, grant, page).allow || !projectable.has(page.relPath) || !exists) return true;
    if (layer === "search" && ctx.db.query("SELECT 1 FROM search_documents WHERE scope='canon' AND path=? AND doc_id=?").get(page.relPath, `page:${page.id}`) === null) return true;
  }
  // Graph has no row for an isolated page. A missing generation indicates it was never projected.
  return layer === "graph" && !readDerivedMeta(ctx.db, "graph") && pages.some(page => eligible(page) && pageDecision(index, grant, page).allow);
}

/** An absent floor matters only when this principal has readable ledger evidence. */
export function visibleLedgerIndexMissing(ctx: ServeContext, grant: Grant): boolean {
  if (tableExists(ctx.db, "search_docs")) return false;
  return timelineSelection(ctx.db, {
    ceiling: grant.ceiling, limit: 1,
    ...(grant.types === null ? {} : { kinds: grant.types }),
    ...(grant.subjects === null ? {} : { subjects: grant.subjects }),
    ...(grant.since === null ? {} : { since: grant.since }),
    ...(grant.until === null ? {} : { until: grant.until }),
    source: { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall" },
  }).length > 0;
}
