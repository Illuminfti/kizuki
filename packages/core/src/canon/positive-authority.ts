import type { Database } from "bun:sqlite";

/** Internal availability state. Never serialize its reason to scoped callers. */
export class ErasurePendingError extends Error {
  readonly code = "erasure_pending";
  constructor() { super("positive authority mutation unavailable during erasure recovery"); }
}
/** Call inside the operation's immediate transaction, after exact replay and
 * before its first positive mutation. Erasure advancement, revoke and capture
 * use their existing checked negative-write paths and do not call this gate. */
export function assertPositiveAuthorityMutationAllowed(db: Database): void {
  if (!db.inTransaction) throw new Error("authority fence requires a transaction");
  if (db.query("SELECT 1 FROM canon_source_erasure_intents LIMIT 1").get() !== null) throw new ErasurePendingError();
}
