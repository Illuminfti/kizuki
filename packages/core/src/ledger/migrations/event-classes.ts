import type { Database } from "bun:sqlite";
import { addDenyClasses } from "../../agents/schema";
import { applyEventClassesTable, backfillCredentialClasses } from "../event-classes";

/**
 * The event class migration. Adds the event class side table, stamps the credential
 * class on every stored event so no agent reads an unstamped one, and lets an
 * agent grant name `deny_classes`. A grant that never names it keeps a NULL
 * column and takes the default denial, so no stored grant is rewritten.
 * Additive: it touches no existing event or grant row.
 */
export function applyEventClassesMigration(db: Database): void {
  applyEventClassesTable(db);
  addDenyClasses(db);
  backfillCredentialClasses(db);
}
