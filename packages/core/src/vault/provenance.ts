import type { Database } from "bun:sqlite";
import { parsePageSources } from "./schema";

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
