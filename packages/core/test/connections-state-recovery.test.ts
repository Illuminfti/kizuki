import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { openLedger } from "../src/ledger/db";
import { ConnectionStateStore } from "../src/ledger/connection-state";
import { clearSwapDebris } from "../src/ledger/connection-state-files";
import { enrollConnection } from "../src/ledger/enroll";
import { LedgerError } from "../src/ledger/connections";
import { sha256Hex } from "../src/util/hash";
import {
  connector,
  enrolled,
  io,
  temporaryDirectories,
} from "./connections-helpers";

const { temporary, cleanup } = temporaryDirectories("kizuki-state-recovery-");

afterEach(cleanup);

describe("connection state recovery and locking", () => {
  test("a rewrite refuses while another connection holds the write lock", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "first-envelope");
    // A writer in another process is mid-swap: it holds the database's write
    // lock across its own rename and commit, and this one must not rename a
    // durable file underneath it.
    const other = new Database(join(directory, "ledger.sqlite"));
    other.exec("BEGIN IMMEDIATE");
    try {
      await expect(
        store.rewrite(db, connection, (writer) =>
          writer.write(new TextEncoder().encode("second-envelope")),
        ),
      ).rejects.toBeInstanceOf(LedgerError);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }

    expect(new TextDecoder().decode(store.read(connection) ?? new Uint8Array())).toBe(
      "first-envelope",
    );
    expect(readdirSync(store.directory)).toEqual([
      `${connection.source_key}.state`,
    ]);
    db.close();
  });

  test("recovery refuses to repair while another connection holds the write lock", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "first-envelope");
    const finalName = `${connection.source_key}.state`;
    const backupName = `${finalName}.01ARZ3NDEKTSV4RRFFQ69G5FAV.rollback`;
    const journalName = `${finalName}.01ARZ3NDEKTSV4RRFFQ69G5FAW.journal`;
    // The tree a swap in another process leaves while it runs: a durable
    // journal, the bytes it replaced kept as a rollback, and its own bytes in
    // place. Its row is not committed yet, so a repair reads it as a crash.
    writeFileSync(join(store.directory, backupName), "first-envelope", {
      mode: 0o600,
    });
    writeFileSync(join(store.directory, finalName), "second-envelope", {
      mode: 0o600,
    });
    writeFileSync(
      join(store.directory, journalName),
      JSON.stringify({
        schema: "kizuki.connection-state-swap/v1",
        connector_id: connection.connector_id,
        source_key: connection.source_key,
        connected_at: "2026-03-01T10:00:00.000Z",
        final_name: finalName,
        backup_name: backupName,
        final_sha256: sha256Hex("second-envelope"),
        final_bytes: new TextEncoder().encode("second-envelope").byteLength,
      }),
      { mode: 0o600 },
    );

    const other = new Database(join(directory, "ledger.sqlite"));
    other.exec("BEGIN IMMEDIATE");
    try {
      expect(() => new ConnectionStateStore(directory).recover(db)).toThrow(
        LedgerError,
      );
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }

    // Nothing was rolled back over the swap the lock holder still owns.
    expect(readFileSync(join(store.directory, finalName), "utf8")).toBe(
      "second-envelope",
    );
    expect(readdirSync(store.directory).sort()).toEqual(
      [finalName, backupName, journalName].sort(),
    );
    db.close();
  });

  test("debris a committed swap cannot remove does not fail the swap", () => {
    const directory = temporary();
    const store = new ConnectionStateStore(directory);
    // The row and the durable file are already committed when this runs, so a
    // removal that fails is debris, never a lost write. Refusing here would
    // report failure for a swap that landed and leave the caller holding a
    // connection the store has moved past.
    const backupPath = join(store.directory, "held.rollback");
    mkdirSync(backupPath);
    writeFileSync(join(backupPath, "occupant"), "not removable in one call");
    const journalPath = join(store.directory, "spent.journal");
    writeFileSync(journalPath, "{}", { mode: 0o600 });

    expect(() => clearSwapDebris(store.directory, { backupPath, journalPath })).not.toThrow();
    // The one it could remove is still gone.
    expect(existsSync(journalPath)).toBe(false);
    rmSync(backupPath, { recursive: true, force: true });
  });

  test("recovery clears the debris a committed swap left behind", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "second-envelope");
    const finalName = `${connection.source_key}.state`;
    const backupName = `${finalName}.01ARZ3NDEKTSV4RRFFQ69G5FAV.rollback`;
    const journalName = `${finalName}.01ARZ3NDEKTSV4RRFFQ69G5FAW.journal`;
    // What is on disk when the post-commit cleanup could not finish: the row
    // names the new bytes, and the journal that proves it is still there.
    writeFileSync(join(store.directory, backupName), "first-envelope", {
      mode: 0o600,
    });
    writeFileSync(
      join(store.directory, journalName),
      JSON.stringify({
        schema: "kizuki.connection-state-swap/v1",
        connector_id: connection.connector_id,
        source_key: connection.source_key,
        connected_at: connection.connected_at,
        final_name: finalName,
        backup_name: backupName,
        final_sha256: sha256Hex("second-envelope"),
        final_bytes: new TextEncoder().encode("second-envelope").byteLength,
      }),
      { mode: 0o600 },
    );

    new ConnectionStateStore(directory).recover(db);

    expect(readdirSync(store.directory)).toEqual([finalName]);
    expect(new TextDecoder().decode(store.read(connection) ?? new Uint8Array())).toBe(
      "second-envelope",
    );
    db.close();
  });

  test("a staging file swept from under a writer becomes a ledger error", async () => {
    const directory = temporary();
    const db = openLedger(join(directory, "ledger.sqlite"));
    const store = new ConnectionStateStore(directory);
    let raised: unknown;
    try {
      await enrollConnection(
        db,
        store,
        connector(async (_io, state) => {
          await state.write(new TextEncoder().encode("first-envelope"));
          // What a recovery sweep in another process does to a staging file
          // it cannot know is still owned.
          for (const name of readdirSync(store.directory)) {
            if (!name.endsWith(".tmp")) continue;
            rmSync(join(store.directory, name), { force: true });
          }
          return { display: "ada" };
        }),
        io,
      );
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(LedgerError);
    // A caller of this store never receives a filesystem path.
    expect((raised as Error).message).toBe("connection state staging is missing");
    expect((raised as Error).message).not.toContain(directory);
    expect(readdirSync(store.directory)).toEqual([]);
    db.close();
  });

  test("recovery leaves a staging file young enough to still have an owner", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "first-envelope");
    const staged = join(
      store.directory,
      `${connection.source_key}.state.01ARZ3NDEKTSV4RRFFQ69G5FAV.tmp`,
    );
    writeFileSync(staged, "SENTINEL-REFRESH", { mode: 0o600 });
    // Longer than a whole browser sign-in may take, and still inside the
    // window a writer in another process can hold one open.
    const recent = new Date(Date.now() - 600_000);
    utimesSync(staged, recent, recent);

    new ConnectionStateStore(directory).recover(db);

    expect(readdirSync(store.directory).sort()).toEqual(
      [`${connection.source_key}.state`, basename(staged)].sort(),
    );
    db.close();
  });

  test("recovery sweeps the staging file a killed writer left behind", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "first-envelope");
    const abandoned = join(
      store.directory,
      `${connection.source_key}.state.01ARZ3NDEKTSV4RRFFQ69G5FAV.tmp`,
    );
    writeFileSync(abandoned, "SENTINEL-REFRESH", { mode: 0o600 });
    const long_ago = new Date(Date.now() - 3_600_000);
    utimesSync(abandoned, long_ago, long_ago);

    // A fresh store is what the next process holds after the crash.
    new ConnectionStateStore(directory).recover(db);

    expect(readdirSync(store.directory)).toEqual([
      `${connection.source_key}.state`,
    ]);
    db.close();
  });

  test("recovery leaves the staging file this store still owns", async () => {
    const directory = temporary();
    const { db, store, connection } = await enrolled(directory, "first-envelope");
    const pending = store.begin();
    await pending.writer.write(new TextEncoder().encode("SENTINEL-REFRESH"));
    const staged = readdirSync(store.directory).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(staged).toHaveLength(1);
    const long_ago = new Date(Date.now() - 3_600_000);
    for (const name of staged) {
      utimesSync(join(store.directory, name), long_ago, long_ago);
    }

    store.recover(db);
    expect(
      readdirSync(store.directory).filter((name) => name.endsWith(".tmp")),
    ).toEqual(staged);

    store.discard(pending.pending);
    expect(readdirSync(store.directory)).toEqual([
      `${connection.source_key}.state`,
    ]);
    db.close();
  });
});
