import { afterEach, describe, expect, test } from "bun:test";
import { MAX_CONNECTION_STATE_BYTES } from "../src/ledger/connection-state";
import { createStatePersister } from "../src/ledger/state-persister";
import { LedgerError, listConnections } from "../src/ledger/connections";
import {
  connector,
  enrolled,
  io,
  temporaryDirectories,
} from "./connections-helpers";

const { temporary, cleanup } = temporaryDirectories("kizuki-state-persister-");

afterEach(cleanup);

describe("host-lent state persister", () => {
  test("serialises overlapping writes and tracks the latest connection", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(
      directory,
      new TextEncoder().encode("first-envelope"),
    );
    const handle = createStatePersister(db, store, connection);

    await Promise.all([
      handle.persist(new TextEncoder().encode("second-envelope")),
      handle.persist(new TextEncoder().encode("third-envelope")),
    ]);

    expect(handle.current().source_key).toBe(connection.source_key);
    expect(
      new TextDecoder().decode(store.read(handle.current()) ?? new Uint8Array()),
    ).toBe("third-envelope");
    expect(listConnections(db)).toHaveLength(1);
    db.close();
  });

  test("a handle that fell behind refuses rather than overwrite the winner", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(
      directory,
      new TextEncoder().encode("first-envelope"),
    );
    // Two runs in one process — a backfill and a sync — each lent a persister.
    const backfill = createStatePersister(db, store, connection);
    const sync = createStatePersister(db, store, connection);

    await backfill.persist(new TextEncoder().encode("second-envelope"));
    // The second handle's snapshot is the row the first one moved past.
    await expect(
      sync.persist(new TextEncoder().encode("third-envelope")),
    ).rejects.toThrow(LedgerError);
    // Refusing costs the writer that is current nothing: it keeps writing.
    await backfill.persist(new TextEncoder().encode("fourth-envelope"));

    expect(
      new TextDecoder().decode(store.read(backfill.current()) ?? new Uint8Array()),
    ).toBe("fourth-envelope");
    expect(listConnections(db)).toHaveLength(1);
    db.close();
  });

  test("a re-sign-in for another account is never overwritten by a stale refresh", async () => {
    const directory = temporary();
    const { db, store, connection: ada } = await enrolled(
      directory,
      new TextEncoder().encode("ada-envelope"),
    );
    // The connector run that started under ada still holds its persister.
    const lent = createStatePersister(db, store, ada);

    const grace = await store.replace(
      db,
      ada,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("grace-envelope"));
        return { display: "grace" };
      }),
      io,
    );

    await expect(
      lent.persist(new TextEncoder().encode("ada-refreshed-envelope")),
    ).rejects.toThrow(LedgerError);
    expect(
      new TextDecoder().decode(store.read(grace) ?? new Uint8Array()),
    ).toBe("grace-envelope");
    expect(listConnections(db)).toHaveLength(1);
    db.close();
  });

  test("a failed write leaves the handle usable for the next one", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(
      directory,
      new TextEncoder().encode("first-envelope"),
    );
    const handle = createStatePersister(db, store, connection);

    await expect(
      handle.persist(new Uint8Array(MAX_CONNECTION_STATE_BYTES + 1)),
    ).rejects.toThrow(LedgerError);
    await handle.persist(new TextEncoder().encode("second-envelope"));
    expect(
      new TextDecoder().decode(store.read(handle.current()) ?? new Uint8Array()),
    ).toBe("second-envelope");
    db.close();
  });
});
