import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import type {
  Connector,
  ConnectionStateWriter,
  SecretResolver,
  SignInIo,
} from "../src/contracts/connector";
import type { OAuthProvider } from "../src/auth/oauth";
import { encodeOAuthState, parseOAuthState } from "../src/auth/state";
import type { OAuthState } from "../src/auth/state";
import {
  ConnectionStateStore,
  MAX_CONNECTION_STATE_BYTES,
  enrollConnection,
} from "../src/ledger/connection-state";
import { createStatePersister } from "../src/ledger/state-persister";
import {
  LedgerError,
  disconnect,
  listConnections,
} from "../src/ledger/connections";
import type { Connection } from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";

const directories: string[] = [];

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-state-rewrite-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function connector(
  signIn: (io: SignInIo, state: ConnectionStateWriter) => Promise<unknown>,
): Connector {
  return {
    manifest: () => ({
      schema: "kizuki.connector/v1",
      connector_id: "fixture",
      version: "1",
      kinds: ["message"],
      capabilities: {
        backfill: false,
        sync: false,
        tombstones: false,
        purge: false,
        fixture: false,
      },
      required_secrets: [],
      emits_sensitivity_hint: false,
      auth_modes: ["sign_in"],
    }),
    health: async () => {
      throw new Error("unused");
    },
    connect: async () => undefined,
    backfill: async () => ({ events: [], cursor: null }),
    sync: async () => ({ events: [], cursor: null }),
    revoke: async () => undefined,
    signIn: async (io, state) =>
      signIn(io, state) as Promise<{ display: string }>,
    purgeSource: async () => ({
      subject_id: "",
      source_record_ids: [],
      unreachable_source_record_ids: [],
    }),
    fixture: async () => [],
  };
}

const io: SignInIo = {
  prompt: async () => "",
  notify: () => undefined,
  openUrl: async () => undefined,
};

describe("non-interactive state rewrite", () => {
  async function enrolled(
    directory: string,
    bytes: string,
  ): Promise<{ db: Database; store: ConnectionStateStore; connection: Connection }> {
    const db = openLedger(join(directory, "ledger.sqlite"));
    const store = new ConnectionStateStore(directory);
    const connection = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode(bytes));
        return { display: "ada" };
      }),
      io,
    );
    return { db, store, connection };
  }

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
    const sourceKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
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

describe("host-lent state persister", () => {
  test("serialises overlapping writes and tracks the latest connection", async () => {
    const directory = temporary();
    const db = openLedger(join(directory, "ledger.sqlite"));
    const store = new ConnectionStateStore(directory);
    const connection = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("first-envelope"));
        return { display: "ada" };
      }),
      io,
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
    const db = openLedger(join(directory, "ledger.sqlite"));
    const store = new ConnectionStateStore(directory);
    const connection = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("first-envelope"));
        return { display: "ada" };
      }),
      io,
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
    const db = openLedger(join(directory, "ledger.sqlite"));
    const store = new ConnectionStateStore(directory);
    const ada = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("ada-envelope"));
        return { display: "ada" };
      }),
      io,
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
    const db = openLedger(join(directory, "ledger.sqlite"));
    const store = new ConnectionStateStore(directory);
    const connection = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("first-envelope"));
        return { display: "ada" };
      }),
      io,
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

describe("OAuth state through the trusted host", () => {
  const provider: OAuthProvider = {
    name: "fixture",
    authorization_url: "https://provider.invalid/authorize",
    token_url: "https://provider.invalid/token",
    client_id: "fixture-client",
    scopes: ["read"],
  };

  function envelope(access: string, refresh: string): OAuthState {
    return {
      schema: "kizuki.oauth-state/v1",
      provider: provider.name,
      account: { id: "acct-ada", display: "ada@example.invalid" },
      tokens: {
        access_token: access,
        refresh_token: refresh,
        expires_at: "2026-03-01T11:00:00.000Z",
        scope: "read",
        token_type: "Bearer",
      },
      written_at: "2026-03-01T10:00:00.000Z",
    };
  }

  test("tokens survive enrollment and refresh without reaching SQLite", async () => {
    const directory = temporary();
    const db = openLedger(join(directory, "ledger.sqlite"));
    const store = new ConnectionStateStore(directory);
    const connection = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(
          encodeOAuthState(envelope("SENTINEL-ACCESS", "SENTINEL-REFRESH")),
        );
        return { display: "ada@example.invalid" };
      }),
      io,
    );

    const enrolledState = parseOAuthState(
      store.read(connection) ?? new Uint8Array(),
      provider.name,
    );
    expect(enrolledState.tokens.access_token).toBe("SENTINEL-ACCESS");

    const handle = createStatePersister(db, store, connection);
    await handle.persist(
      encodeOAuthState(envelope("SENTINEL-SECOND", "SENTINEL-ROTATED")),
    );

    const secrets = [
      "SENTINEL-ACCESS",
      "SENTINEL-REFRESH",
      "SENTINEL-SECOND",
      "SENTINEL-ROTATED",
    ];
    const rows = db
      .query<Record<string, unknown>, []>("SELECT * FROM connections")
      .all();
    expect(rows).toHaveLength(1);
    for (const secret of secrets) {
      expect(JSON.stringify(rows)).not.toContain(secret);
    }

    // Closing checkpoints the write-ahead log: a row scan of the main file
    // alone would miss bytes that are still only in ledger.sqlite-wal.
    db.close();
    const artifacts = readdirSync(directory).filter((name) =>
      name.startsWith("ledger.sqlite"),
    );
    expect(artifacts).toContain("ledger.sqlite");
    for (const name of artifacts) {
      const bytes = new TextDecoder().decode(readFileSync(join(directory, name)));
      for (const secret of secrets) {
        expect(bytes).not.toContain(secret);
      }
    }
  });

  test("the host resolver convention hands the connector state as text", async () => {
    const directory = temporary();
    const db = openLedger(join(directory, "ledger.sqlite"));
    const store = new ConnectionStateStore(directory);
    const connection = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(
          encodeOAuthState(envelope("SENTINEL-ACCESS", "SENTINEL-REFRESH")),
        );
        return { display: "ada@example.invalid" };
      }),
      io,
    );

    const stateRef = connection.secret_refs[0] ?? "";
    const resolve: SecretResolver = async (ref) => {
      if (ref !== stateRef) {
        throw new LedgerError("connection state resolver refuses other refs");
      }
      return new TextDecoder().decode(store.read(connection) ?? new Uint8Array());
    };

    expect(await resolve(stateRef).then((text) => parseOAuthState(text, provider.name))).toEqual(
      envelope("SENTINEL-ACCESS", "SENTINEL-REFRESH"),
    );
    db.close();
  });
});
