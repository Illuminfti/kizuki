import type { Database } from "bun:sqlite";
import { readDerivedHolds } from "./derived-holds";
import { readDerivedMeta, stampDerived } from "./derived-meta";
import type { CanonPageReport } from "./vault/pages";
import { canonPagesHash, isLiveCanonPage } from "./vault/pages";
import { assessLivePageEvidence, isDeterministicBrief } from "./vault/provenance";
import { sourceEventsAllowed } from "./ledger/source-grants";
import { CanonAuthorityResolver } from "./canon/authority";
import { ulid } from "./util/ulid";

/** Owner diagnostics over the same current exclusions used by local projections. */
export function derivedPageSkips(db: Database, report: CanonPageReport): { path: string; reason: string }[] {
  const skipped = new Map<string, string>(report.skipped.map(page => [page.relPath, page.code]));
  const held = readDerivedHolds(db).paths;
  const resolver = new CanonAuthorityResolver(db, report.pages.map(page => page.relPath));
  for (const page of report.pages) {
    if (!isLiveCanonPage(page) || isDeterministicBrief(page)) continue;
    if (held.has(page.relPath)) { skipped.set(page.relPath, "held"); continue; }
    const evidence = assessLivePageEvidence(db, page, resolver);
    if (!evidence.admitted) skipped.set(page.relPath, evidence.reason);
    else if (!sourceEventsAllowed(db, evidence.sourceIds, { owner: true, purpose: "derive" })) skipped.set(page.relPath, "source_derivation_denied");
  }
  return [...skipped].map(([path, reason]) => ({ path, reason })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** A completed canon snapshot can clear old failures without rebuilding ledger FTS. */
export function refreshSearchHealth(db: Database, report: CanonPageReport): void {
  const existing = readDerivedMeta(db, "search");
  const skips = derivedPageSkips(db, report);
  const counts = db.query<{ scope: string; n: number }, []>("SELECT scope, count(*) AS n FROM search_documents GROUP BY scope").all();
  const docs = counts.reduce((sum, row) => sum + row.n, 0);
  const events = counts.find(row => row.scope === "ledger")?.n ?? 0;
  const held = readDerivedHolds(db).paths;
  const skippedPaths = new Set(skips.map(skip => skip.path));
  const skippedCount = skips.length + [...held].filter(path => !skippedPaths.has(path)).length;
  stampDerived(db, {
    layer: "search", generation: existing?.generation ?? ulid(), rebuilt_at: new Date().toISOString(),
    doc_count: docs, source_count: report.pages.filter(page => isLiveCanonPage(page) && !isDeterministicBrief(page)).length + events,
    skipped_count: skippedCount,
    status: skippedCount > 0 || report.truncated ? "degraded" : "ok",
    ledger_watermark: existing?.ledger_watermark ?? null,
    canon_hash: skippedCount === 0 && !report.truncated ? canonPagesHash(report.pages.filter(isLiveCanonPage)) : null,
    port_id: "kizuki.retrieval.fts5", contract: "kizuki.retrieval/v1",
  });
}
