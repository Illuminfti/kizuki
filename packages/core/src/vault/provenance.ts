import { OWNER } from "../agents";
import { getWorldCanonReceipt } from "../canon/receipts";
import { worldBasisAllowed } from "../canon/world-materialization";
import type { ServeContext } from "../serving/types";
import type { Database } from "bun:sqlite";
import { CanonAuthorityResolver, type CanonRevisionBasis } from "../canon/authority";
import { canonPageRecoveryPending } from "../canon/write-intent";
import { readLiveEvent } from "../ledger/ledger";
import { sourceEventsAllowed } from "../ledger/source-grants";
import { eventIdFromReference } from "../retrieval/ids";
import { isLiveCanonPage, type CanonPage } from "./pages";
import { parsePageSources } from "./schema";

/** Administrative daemon summaries have no event basis and are outside evidence indexes. */
export function isDeterministicBrief(page: CanonPage): boolean {
  return /^dashboards\/brief-\d{4}-\d{2}-\d{2}\.md$/.test(page.relPath)
    && page.id === `rollup:${page.relPath.slice("dashboards/".length, -3)}`
    && page.data["type"] === "rollup"
    && page.data["x-brief-producer"] === "deterministic"
    && Array.isArray(page.data["sources"]) && page.data["sources"].length === 0;
}

export type LivePageEvidence =
  | { admitted: true; sourceIds: string[]; revision: CanonRevisionBasis }
  | { admitted: false; reason: "inactive" | "sources_unavailable" | "revision_unrecorded" | "recovery_pending" };

/** Internal read-phase seam; publication and writer checks use the live reader. */
export type PageEvidenceReader = (page: CanonPage, context: ServeContext, historical: boolean) => LivePageEvidence;

/** Existing evidence only. The caller owns the bounded page and database snapshot. */
export function assessLivePageEvidence(
  db: Database,
  page: CanonPage,
  resolver?: CanonAuthorityResolver,
  context?: ServeContext,
  historicalSnapshot = false,
  liveExternalEvent?: (id: string) => boolean,
): LivePageEvidence {
  if (!isLiveCanonPage(page) && !(historicalSnapshot && page.data["status"] === "archived")) return { admitted: false, reason: "inactive" };
  if (canonPageRecoveryPending(db, page.relPath)) return { admitted: false, reason: "recovery_pending" };
  const sources = parsePageSources(page.data);
  if (!sources.ok) return { admitted: false, reason: "sources_unavailable" };
  // Shape-valid but sourceless pages (the deterministic brief rollup) are not
  // evidence. Fail closed rather than admit a page that names no event.
  if (sources.value.length === 0) return { admitted: false, reason: "sources_unavailable" };
  const sourceIds = [...new Set(sources.value.map(eventIdFromReference))];
  try {
    const revision = (resolver ?? new CanonAuthorityResolver(db, [page.relPath])).basis(page.relPath, page.contentHash);
    // An unrecorded revision still reports unavailable sources first, as it did
    // before typed receipts; only a recorded typed revision skips that check.
    const receipt = revision === null ? null : getWorldCanonReceipt(db,revision.receipt_id);
    if (revision !== null && receipt !== null) {
      // A correction diff can include an archived after image, whose retained
      // body belongs to the before basis. Normal serving admits only live after bases.
      const basis = receipt.basis.after ?? (historicalSnapshot ? receipt.basis.before : null);
      if (basis === null || !worldBasisAllowed(context ?? {db,vaultPath:"",principal:OWNER,sourcePurpose:"derive"},basis,historicalSnapshot)) return {admitted:false,reason:"sources_unavailable"};
      return {admitted:true,sourceIds,revision};
    }
    for (const id of sourceIds) {
      const valid = liveExternalEvent === undefined
        ? readLiveEvent(db, id)?.origin === "external" : liveExternalEvent(id);
      if (!valid) {
        return { admitted: false, reason: "sources_unavailable" };
      }
    }
    return revision === null
      ? { admitted: false, reason: "revision_unrecorded" }
      : { admitted: true, sourceIds, revision };
  } catch {
    return { admitted: false, reason: "sources_unavailable" };
  }
}

/** Local positive projections additionally require current derivation permission. */
export function projectablePageEvidence(db: Database, pages: readonly CanonPage[]): Map<string, Extract<LivePageEvidence, { admitted: true }>> {
  const resolver = new CanonAuthorityResolver(db, pages.map(page => page.relPath));
  const admitted = new Map<string, Extract<LivePageEvidence, { admitted: true }>>();
  for (const page of pages) {
    const evidence = assessLivePageEvidence(db, page, resolver);
    if (evidence.admitted && sourceEventsAllowed(db, evidence.sourceIds, { owner: true, purpose: "derive" })) {
      admitted.set(page.relPath, evidence);
    }
  }
  return admitted;
}

/**
 * Owner diagnostics, independent of source consent. The caller owns the read
 * transaction; archived history may name evidence erased by a receipted purge.
 * No source IDs, body text, or underlying database errors enter the diagnostic.
 */
export function pageProvenanceErrors(db: Database, data: Record<string, unknown>): string[] {
  const sources = parsePageSources(data);
  if (!sources.ok) return sources.errors;
  if (data["status"] === "archived") return [];
  try {
    using event = db.prepare<{ event_id: string }, [string]>(
      "SELECT event_id FROM events WHERE event_id=?",
    );
    if (sources.value.some((id) => event.get(id) === null)) {
      return ["sources: one or more event IDs do not resolve in the ledger"];
    }
    return [];
  } catch {
    return ["sources: ledger provenance could not be checked"];
  }
}
