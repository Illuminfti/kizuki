import type { Database } from "bun:sqlite";
import type { StatePersister } from "../auth/session";
import {
  CONCURRENT_CONNECTION_CHANGE,
  STALE_CONNECTION_SNAPSHOT,
  type ConnectionStateStore,
} from "./connection-state";
import { LedgerError, getConnection, type Connection } from "./connections";

export interface StatePersisterHandle {
  /** Serialised: calls run one after another, never concurrently. */
  persist: StatePersister;
  /** The connection as of the latest successful rewrite. */
  current(): Connection;
}

/** A snapshot the row has moved past; the write itself was never attempted. */
function isBehind(error: unknown): boolean {
  return (
    error instanceof LedgerError &&
    (error.message === STALE_CONNECTION_SNAPSHOT ||
      error.message === CONCURRENT_CONNECTION_CHANGE)
  );
}

/**
 * Lends a connector the ability to persist refreshed state for exactly one
 * connection. Writes are chained because two overlapping refreshes would
 * otherwise collide on the store's single active enrollment per source.
 *
 * One handle per connection per process is the intended shape, but a second
 * run may hold one over the same row. Every rewrite advances `connected_at`,
 * so such a handle is behind from the first write another one commits; it
 * re-reads the row once rather than dying, because a rotated refresh token it
 * cannot write back is a token the next process no longer has.
 */
export function createStatePersister(
  db: Database,
  store: ConnectionStateStore,
  connection: Connection,
): StatePersisterHandle {
  let current = connection;
  let queue: Promise<void> = Promise.resolve();
  const write = async (bytes: Uint8Array): Promise<void> => {
    try {
      current = await store.rewrite(db, current, (writer) => writer.write(bytes));
      return;
    } catch (error) {
      if (!isBehind(error)) throw error;
      const fresh = getConnection(db, current.connector_id, current.source_key);
      if (fresh === null) throw error;
      current = fresh;
    }
    // The reread is a snapshot too, so a second loss is the caller's to see.
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
