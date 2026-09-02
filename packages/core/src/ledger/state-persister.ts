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
 */
export function createStatePersister(
  db: Database,
  store: ConnectionStateStore,
  connection: Connection,
): StatePersisterHandle {
  let current = connection;
  let queue: Promise<void> = Promise.resolve();
  const persist: StatePersister = (bytes) => {
    const write = queue.then(async () => {
      current = await store.rewrite(db, current, (writer) => writer.write(bytes));
    });
    // A rejected write must not poison the queue for the next refresh.
    queue = write.catch(() => undefined);
    return write;
  };
  return { persist, current: () => current };
}
