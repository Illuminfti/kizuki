import type { Database } from "bun:sqlite";
import type { Connector, SignInIo } from "../contracts/connector";
import { ConnectionStateStore } from "./connection-state";
import { LedgerError, type Connection } from "./connections";

/** Runs an interactive sign-in and persists only host-minted opaque state. */
export async function enrollConnection(
  db: Database,
  store: ConnectionStateStore,
  connector: Connector,
  io: SignInIo,
): Promise<Connection> {
  if (typeof connector.signIn !== "function") {
    throw new LedgerError("connector does not implement interactive sign-in");
  }
  store.recover(db);
  const pending = store.begin();
  try {
    await connector.signIn(io, pending.writer);
    return store.save(db, connector.manifest().connector_id, pending.pending);
  } catch (error) {
    store.discard(pending.pending);
    throw error;
  }
}
