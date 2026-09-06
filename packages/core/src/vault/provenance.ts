import type { Database } from "bun:sqlite";
import { CanonAuthorityResolver, type CanonRevisionBasis } from "../canon/authority";
import { readEvent } from "../ledger/ledger";
import { sourceEventsAllowed } from "../ledger/source-grants";
import { eventIdFromReference } from "../retrieval/ids";
import { isLiveCanonPage, type CanonPage } from "./pages";
import { parsePageSources } from "./schema";

export type LivePageEvidence =
  | { admitted: true; sourceIds: string[]; revision: CanonRevisionBasis }
  | { admitted: false; reason: "inactive" | "sources_unavailable" | "revision_unrecorded" };

/** Existing evidence only. The caller owns the bounded page and database snapshot. */
export function assessLivePageEvidence(
  db: Database,
  page: CanonPage,
  resolver?: CanonAuthorityResolver,
): LivePageEvidence {
  if (!isLiveCanonPage(page)) return { admitted: false, reason: "inactive" };
  const sources = parsePageSources(page.data);
  if (!sources.ok) return { admitted: false, reason: "sources_unavailable" };
  const sourceIds = [...new Set(sources.value.map(eventIdFromReference))];
  try {
    for (const id of sourceIds) {
      const event = readEvent(db, id);
      if (event === null || event.deleted || event.origin !== "external") {
        return { admitted: false, reason: "sources_unavailable" };
      }
    }
    const revision = (resolver ?? new CanonAuthorityResolver(db, [page.relPath])).basis(page.relPath, page.contentHash);
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
