import type { Database } from "bun:sqlite";
import { requireSourceEvents } from "../ledger/source-grants";

/** Canon publication requires derivation consent, including for corrections. */
export function requireCanonSourceConsent(db: Database, sources: readonly string[]): void {
  requireSourceEvents(db, sources, { owner: true, purpose: "derive" });
}
