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
import { eligible, pageDecision, pageScope, type CanonIndex } from "./canon";

/** Query health is a property of the caller's visible corpus, never a global stamp. */
export function visibleIndexDegraded(index: CanonIndex, grant: Grant, layer: "search" | "graph", pages: readonly CanonPage[] = index.pages): boolean {
  const ctx = index.sourceContext;
  // Scope and source policy precede all receipt/provenance reconstruction.
  const permitted = pages.filter(page => {
    if (index.deniedPaths.has(page.relPath) || !eligible(page) || isDeterministicBrief(page) || !authorize(grant, pageScope(page)).allow) return false;
    const sources = stringArray(page.data["sources"]).map(eventIdFromReference);
    if (ctx.principal.kind !== "owner" && sources.length === 0) return false;
    const original = sensitivity(page.data["sensitivity"]);
    return original !== null
      && sourceEventsAllowed(ctx.db, sources, { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall" })
      && authorize(grant, { ...pageScope(page), sensitivity: sourceSensitivity(ctx.db, sources, original) }).allow;
  });
  const projectable = projectablePageEvidence(ctx.db, permitted);
  const exists = layer === "search"
    ? tableExists(ctx.db, "search_documents") && tableExists(ctx.db, "search_docs")
    : tableExists(ctx.db, "graph_edges");
  for (const page of permitted) {
    const evidence = assessLivePageEvidence(ctx.db, page, undefined, { ...ctx, principal: { ...ctx.principal, grant } });
    if (!evidence.admitted && evidence.reason === "sources_unavailable" && ctx.principal.kind !== "owner") continue;
    if (!pageDecision(index, grant, page).allow || !projectable.has(page.relPath) || !exists) return true;
    if (layer === "search" && ctx.db.query("SELECT 1 FROM search_documents WHERE scope='canon' AND path=? AND doc_id=? AND EXISTS (SELECT 1 FROM search_docs f WHERE f.rowid=search_documents.rowid AND f.doc_id=search_documents.doc_id)").get(page.relPath, `page:${page.id}`) === null) return true;
  }
  // Graph has no row for an isolated page. A missing generation indicates it was never projected.
  return layer === "graph" && !readDerivedMeta(ctx.db, "graph") && permitted.some(page => pageDecision(index, grant, page).allow);
}

/** Coverage is checked inside the permitted live ledger corpus, before LIMIT. */
export function visibleLedgerIndexMissing(ctx: ServeContext, grant: Grant): boolean {
  return timelineSelection(ctx.db, {
    ceiling: grant.ceiling, limit: 1, missingSearchIndex: true,
    ...(grant.types === null ? {} : { kinds: grant.types }),
    ...(grant.subjects === null ? {} : { subjects: grant.subjects }),
    ...(grant.since === null ? {} : { since: grant.since }),
    ...(grant.until === null ? {} : { until: grant.until }),
    source: { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall" },
  }).length > 0;
}
