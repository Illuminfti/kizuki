import type { Database } from "bun:sqlite";
import type { StatePersister } from "../auth/session";
import type { ConnectionStateStore } from "./connection-state";
import type { Connection } from "./connections";

export interface StatePersisterHandle {
  /** Serialised: calls run one after another, never concurrently. */
  persist: StatePersister;
  /** The connection as of the latest successful rewrite. */
  current(): Connection;
}

/**
 * Lends a connector the ability to persist refreshed state for exactly one
 * connection. Writes are chained because two overlapping refreshes would
 * otherwise collide on the store's single active enrollment per source.
 *
 * The handle holds the row it last wrote and offers it to `rewrite` unchanged,
 * so the store's identity check is what decides every write. A handle another
 * writer has moved past therefore fails instead of overwriting: the row it
 * would clobber may belong to a re-sign-in for a different account, and the
 * owner's newest grant outranks a refresh from a run that no longer describes
 * the connection.
 */
export function createStatePersister(
  db: Database,
  store: ConnectionStateStore,
  connection: Connection,
): StatePersisterHandle {
  let current = connection;
  let queue: Promise<void> = Promise.resolve();
  const write = async (bytes: Uint8Array): Promise<void> => {
    current = await store.rewrite(db, current, (writer) => writer.write(bytes));
  };
  const persist: StatePersister = (bytes) => {
    const pending = queue.then(() => write(bytes));
    // A rejected write must not poison the queue for the next refresh.
    queue = pending.catch(() => undefined);
    return pending;
  };
  return { persist, current: () => current };
}
