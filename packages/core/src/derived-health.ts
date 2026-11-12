import type { Database } from "bun:sqlite";
import { readDerivedHolds } from "./derived-holds";
import { derivedStampChanges, readDerivedMeta, stampDerived, type DerivedStamp } from "./derived-meta";
import type { CanonPageReport } from "./vault/pages";
import { canonPagesHash, isLiveCanonPage } from "./vault/pages";
import { assessWalkEvidence, isDeterministicBrief, type WalkEvidence } from "./vault/provenance";
import { latestLedgerCursor } from "./ledger/ledger";
import { searchLedgerWatermark } from "./search/indexer";
import { ulid } from "./util/ulid";

/** Owner diagnostics over the same current exclusions used by local projections. */
export function derivedPageSkips(db: Database, report: CanonPageReport, assessed?: WalkEvidence): { path: string; reason: string }[] {
  const skipped = new Map<string, string>(report.skipped.map(page => [page.relPath, page.code]));
  const held = readDerivedHolds(db).paths;
  const candidates = report.pages.filter(page => isLiveCanonPage(page) && !isDeterministicBrief(page));
  const evidence = assessed ?? assessWalkEvidence(db, candidates.filter(page => !held.has(page.relPath)));
  for (const page of candidates) {
    if (held.has(page.relPath)) { skipped.set(page.relPath, "held"); continue; }
    const assessment = evidence.get(page.relPath);
    // A page the walk did not assess has no evidence to project from.
    if (assessment === undefined) skipped.set(page.relPath, "sources_unavailable");
    else if (!assessment.evidence.admitted) skipped.set(page.relPath, assessment.evidence.reason);
    else if (!assessment.derivable) skipped.set(page.relPath, "source_derivation_denied");
  }
  return [...skipped].map(([path, reason]) => ({ path, reason })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** The search health a walk earns, or null when the stored stamp already says it. */
export function searchHealthStamp(db: Database, report: CanonPageReport, assessed?: WalkEvidence): DerivedStamp | null {
  const existing = readDerivedMeta(db, "search");
  const skips = derivedPageSkips(db, report, assessed);
  const watermark = searchLedgerWatermark(db);
  const latest = latestLedgerCursor(db);
  const ledgerComplete = watermark === (latest === null ? null : `${latest.accepted_at}\t${latest.event_id}`);
  const counts = db.query<{ scope: string; n: number }, []>("SELECT scope, count(*) AS n FROM search_documents GROUP BY scope").all();
  const docs = counts.reduce((sum, row) => sum + row.n, 0);
  const events = counts.find(row => row.scope === "ledger")?.n ?? 0;
  const held = readDerivedHolds(db).paths;
  const skippedPaths = new Set(skips.map(skip => skip.path));
  const skippedCount = skips.length + [...held].filter(path => !skippedPaths.has(path)).length;
  const stamp: DerivedStamp = {
    layer: "search", generation: existing?.generation ?? ulid(), rebuilt_at: new Date().toISOString(),
    doc_count: docs, source_count: report.pages.filter(page => isLiveCanonPage(page) && !isDeterministicBrief(page)).length + events,
    skipped_count: skippedCount,
    status: skippedCount > 0 || report.truncated || !ledgerComplete ? "degraded" : "ok",
    ledger_watermark: watermark,
    canon_hash: skippedCount === 0 && !report.truncated ? canonPagesHash(report.pages.filter(isLiveCanonPage)) : null,
    port_id: "kizuki.retrieval.fts5", contract: "kizuki.retrieval/v1",
  };
  return derivedStampChanges(db, stamp) ? stamp : null;
}

/** A completed canon snapshot can clear old failures without rebuilding ledger FTS. */
export function refreshSearchHealth(db: Database, report: CanonPageReport, assessed?: WalkEvidence): void {
  const stamp = searchHealthStamp(db, report, assessed);
  if (stamp !== null) stampDerived(db, stamp);
}
