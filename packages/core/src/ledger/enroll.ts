import type { Database } from "bun:sqlite";
import type { Connector, SignInIo } from "../contracts/connector";
import type { ConnectionStateStore } from "./connection-state";
import type { Connection } from "./connections";
import { runGuardedSignIn } from "./sign-in-guard";

/** Runs an interactive sign-in and persists only host-minted opaque state. */
export async function enrollConnection(
  db: Database,
  store: ConnectionStateStore,
  connector: Connector,
  io: SignInIo,
): Promise<Connection> {
  store.recover(db);
  const pending = store.begin();
  try {
    await runGuardedSignIn(connector, io, pending.writer);
    return store.save(
      db,
      connector.manifest().connector_id,
      pending.pending,
      undefined,
      connector.manifest().version,
    );
  } catch (error) {
    store.discard(pending.pending);
    throw error;
  }
}
