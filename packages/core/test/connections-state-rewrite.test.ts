import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "../src/ledger/db";
import { writeLocked } from "../src/ledger/connection-state-rows";
import { ConnectionStateStore } from "../src/ledger/connection-state";
import { enrollConnection } from "../src/ledger/enroll";
import { createStatePersister } from "../src/ledger/state-persister";
import {
  LedgerError,
  disconnect,
  listConnections,
} from "../src/ledger/connections";
import {
  connector,
  enrolled,
  io,
  temporaryDirectories,
} from "./connections-helpers";

const { temporary, cleanup } = temporaryDirectories("kizuki-state-rewrite-");

afterEach(cleanup);

describe("non-interactive state rewrite", () => {
  test("swaps the bytes under the same source and keeps one row", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "first-envelope");
    const rewritten = await store.rewrite(db, connection, (writer) =>
      writer.write(new TextEncoder().encode("second-envelope")),
    );

    expect(rewritten.source_key).toBe(connection.source_key);
    expect(listConnections(db)).toHaveLength(1);
    expect(new TextDecoder().decode(store.read(rewritten) ?? new Uint8Array())).toBe(
      "second-envelope",
    );
    expect(
      statSync(join(store.directory, `${connection.source_key}.state`)).mode & 0o777,
    ).toBe(0o600);
    expect(readdirSync(store.directory)).toEqual([
      `${connection.source_key}.state`,
    ]);
    db.close();
  });

  test("a rewrite that writes nothing fails closed and keeps the old state", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "first-envelope");
    await expect(
      store.rewrite(db, connection, async () => undefined),
    ).rejects.toThrow("state rewrite did not provide connection state");
    expect(new TextDecoder().decode(store.read(connection) ?? new Uint8Array())).toBe(
      "first-envelope",
    );
    expect(readdirSync(store.directory)).toEqual([
      `${connection.source_key}.state`,
    ]);
    db.close();
  });

  test("a rewrite of a fabricated connection is rejected before staging", async () => {
    const db = openLedger(":memory:");
    const control = temporary();
    const store = new ConnectionStateStore(control);
    const sourceKey = "01JJ0000000000000000000001";
    await expect(
      store.rewrite(
        db,
        {
          connector_id: "fixture",
          source_key: sourceKey,
          config: {
            schema: "kizuki.connection-config/v1" as const,
            state_ref_index: 0 as const,
          },
          secret_refs: [`file:connections/${sourceKey}.state`],
          connected_at: new Date().toISOString(),
          disconnected_at: null,
        },
        (writer) => writer.write(new TextEncoder().encode("attacker-state")),
      ),
    ).rejects.toThrow(LedgerError);
    expect(readdirSync(join(control, "connections"))).toEqual([]);
    db.close();
  });

  test("a disconnected source is not silently reconnected by a refresh", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "first-envelope");
    disconnect(db, connection.connector_id, connection.source_key);
    const dropped = listConnections(db, { includeDisconnected: true })[0];

    await expect(
      store.rewrite(db, dropped ?? connection, (writer) =>
        writer.write(new TextEncoder().encode("second-envelope")),
      ),
    ).rejects.toThrow("disconnected");
    expect(listConnections(db)).toEqual([]);
    expect(new TextDecoder().decode(store.read(connection) ?? new Uint8Array())).toBe(
      "first-envelope",
    );
    db.close();
  });

  test("an interactive re-sign-in still reconnects a disconnected source", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "first-envelope");
    disconnect(db, connection.connector_id, connection.source_key);
    const dropped = listConnections(db, { includeDisconnected: true })[0];

    const replaced = await store.replace(
      db,
      dropped ?? connection,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("second-envelope"));
        return { display: "ada" };
      }),
      io,
    );

    expect(replaced.disconnected_at).toBeNull();
    expect(listConnections(db)).toHaveLength(1);
    expect(new TextDecoder().decode(store.read(replaced) ?? new Uint8Array())).toBe(
      "second-envelope",
    );
    db.close();
  });

  test("a persister built before a disconnect cannot resurrect the source", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "first-envelope");
    const handle = createStatePersister(db, store, connection);
    disconnect(db, connection.connector_id, connection.source_key);

    // The handle's snapshot is now the row before the disconnect, so the
    // identity check refuses it before the disconnect rule is even reached.
    await expect(
      handle.persist(new TextEncoder().encode("second-envelope")),
    ).rejects.toThrow(LedgerError);
    expect(listConnections(db)).toEqual([]);
    expect(new TextDecoder().decode(store.read(connection) ?? new Uint8Array())).toBe(
      "first-envelope",
    );
    db.close();
  });

  test("a disconnect that lands mid-rewrite is not undone", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "first-envelope");

    await expect(
      store.rewrite(db, connection, async (writer) => {
        disconnect(db, connection.connector_id, connection.source_key);
        await writer.write(new TextEncoder().encode("second-envelope"));
      }),
    ).rejects.toThrow(LedgerError);

    expect(listConnections(db)).toEqual([]);
    expect(new TextDecoder().decode(store.read(connection) ?? new Uint8Array())).toBe(
      "first-envelope",
    );
    expect(readdirSync(store.directory)).toEqual([
      `${connection.source_key}.state`,
    ]);
    db.close();
  });

  test("a rewrite that lost the race leaves the winner's bytes", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "first-envelope");
    const competitor = new ConnectionStateStore(directory);

    await expect(
      store.rewrite(db, connection, async (writer) => {
        await competitor.rewrite(db, connection, (other) =>
          other.write(new TextEncoder().encode("winner")),
        );
        await writer.write(new TextEncoder().encode("loser"));
      }),
    ).rejects.toThrow(LedgerError);

    const current = listConnections(db)[0];
    expect(
      new TextDecoder().decode(store.read(current ?? connection) ?? new Uint8Array()),
    ).toBe("winner");
    expect(readdirSync(store.directory)).toEqual([
      `${connection.source_key}.state`,
    ]);
    db.close();
  });

  test("a connection that never held state cannot be rewritten", async () => {
    const db = openLedger(":memory:");
    const store = new ConnectionStateStore(temporary());
    const stateless = await enrollConnection(
      db,
      store,
      connector(async () => ({ display: "ada" })),
      io,
    );
    await expect(
      store.rewrite(db, stateless, (writer) =>
        writer.write(new TextEncoder().encode("late-envelope")),
      ),
    ).rejects.toThrow("not eligible");
    expect(readdirSync(store.directory)).toEqual([]);
    db.close();
  });
});

describe("the lock a failed swap rolls back under", () => {
  /** What a writer on another connection sees when it tries to take the lock. */
  function competingWrite(db: ReturnType<typeof openLedger>): string | null {
    try {
      writeLocked(db, () => undefined);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  test("no other connection can write between the failure and the undo", () => {
    const path = join(temporary(), "ledger.sqlite");
    const db = openLedger(path);
    const other = openLedger(path);
    const observed: { inTransaction: boolean; competitor: string | null }[] = [];

    expect(() =>
      writeLocked(
        db,
        () => {
          throw new LedgerError("the row commit lost the race");
        },
        () => {
          // This is where the state file is put back. A recovery in another
          // process reaching the journal here would repair the same swap, and
          // the restore would then delete what recovery had just restored.
          observed.push({
            inTransaction: db.inTransaction,
            competitor: competingWrite(other),
          });
        },
      ),
    ).toThrow("the row commit lost the race");

    expect(observed).toEqual([
      {
        inTransaction: true,
        competitor: "connection state is locked by another writer",
      },
    ]);
    expect(db.inTransaction).toBe(false);
    expect(competingWrite(other)).toBeNull();
    db.close();
    other.close();
  });

  test("a rollback that fails leaves the failure the caller has to act on", () => {
    const path = join(temporary(), "ledger.sqlite");
    const db = openLedger(path);
    expect(() =>
      writeLocked(
        db,
        () => {
          throw new LedgerError("the row commit lost the race");
        },
        () => {
          throw new Error("the state file could not be put back");
        },
      ),
    ).toThrow("the row commit lost the race");
    db.close();
  });
});
