import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
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
  createStatePersister,
  enrollConnection,
  writeAll,
} from "../src/ledger/connection-state";
import {
  LedgerError,
  getConnection,
  listConnections,
} from "../src/ledger/connections";
import type { Connection } from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";

const directories: string[] = [];

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-connection-state-"));
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

describe("complete durable writes", () => {
  test("retries short writes until every byte is copied", () => {
    const source = new TextEncoder().encode("partial writes must not truncate state");
    const sink = new Uint8Array(source.byteLength);
    let calls = 0;

    writeAll(7, source, (_fd, bytes, offset, length) => {
      const count = Math.min(3, length);
      sink.set(bytes.subarray(offset, offset + count), offset);
      calls += 1;
      return count;
    });

    expect(sink).toEqual(source);
    expect(calls).toBeGreaterThan(1);
  });

  test("fails closed when a write makes no progress", () => {
    expect(() =>
      writeAll(7, new Uint8Array([1]), () => 0),
    ).toThrow("connection state write made no progress");
  });
});

describe("opaque connector connection state", () => {
  test("round-trips opaque state only through the trusted host reader", async () => {
    const db = openLedger(":memory:");
    const store = new ConnectionStateStore(temporary());
    const saved = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("opaque provider session"));
        return { display: "Ada" };
      }),
      io,
    );
    expect(saved.source_key).toMatch(/^[0-9A-HJKMNPQRSTVWXYZ]{26}$/);
    expect(saved.config).toEqual({
      schema: "kizuki.connection-config/v1",
      state_ref_index: 0,
    });
    expect(saved.secret_refs).toEqual([
      `file:connections/${saved.source_key}.state`,
    ]);
    expect(
      statSync(join(store.directory, `${saved.source_key}.state`)).mode & 0o777,
    ).toBe(0o600);
    expect(
      new TextDecoder().decode(store.read(saved) ?? new Uint8Array()),
    ).toBe("opaque provider session");
    db.close();
  });

  test("connector-authored legacy fields cannot persist and leave no state", async () => {
    const db = openLedger(":memory:");
    const control = temporary();
    const store = new ConnectionStateStore(control);
    const adversarial = connector(async () => ({
      display: "ordinary-plaintext-credential",
      source_key: "attacker-controlled",
      config: { session_id: "ordinary-plaintext-credential" },
      secret_refs: ["file:/etc/passwd"],
    }));
    await expect(enrollConnection(db, store, adversarial, io)).resolves.toMatchObject({
      secret_refs: [],
    });
    const row = listConnections(db)[0];
    expect(row?.source_key).not.toBe("attacker-controlled");
    expect(row?.config.state_ref_index).toBeNull();
    expect(readdirSync(join(control, "connections"))).toEqual([]);
    db.close();
  });

  test("sign-in failure removes pending state and does not create a row", async () => {
    const db = openLedger(":memory:");
    const control = temporary();
    const store = new ConnectionStateStore(control);
    await expect(
      enrollConnection(
        db,
        store,
        connector(async (_io, state) => {
          await state.write(new TextEncoder().encode("temporary-token"));
          throw new Error("denied");
        }),
        io,
      ),
    ).rejects.toThrow("denied");
    expect(listConnections(db)).toEqual([]);
    expect(readdirSync(join(control, "connections"))).toEqual([]);
    db.close();
  });

  test("a failed first enrollment leaves no durable state or row", async () => {
    const db = openLedger(":memory:");
    const control = temporary();
    const store = new ConnectionStateStore(control);
    db.exec(
      "CREATE TRIGGER reject_connection_insert BEFORE INSERT ON connections BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END",
    );
    await expect(
      enrollConnection(
        db,
        store,
        connector(async (_io, state) => {
          await state.write(new TextEncoder().encode("first-token"));
          return { display: "first" };
        }),
        io,
      ),
    ).rejects.toThrow("forced insert failure");
    expect(listConnections(db)).toEqual([]);
    expect(readdirSync(join(control, "connections"))).toEqual([]);
    db.close();
  });

  test("a retained writer cannot write after a successful null-state save", async () => {
    const db = openLedger(":memory:");
    const control = temporary();
    const store = new ConnectionStateStore(control);
    const enrollment = store.begin();
    store.save(db, "fixture", enrollment.pending);
    await expect(
      enrollment.writer.write(new TextEncoder().encode("late-token")),
    ).rejects.toThrow();
    expect(readdirSync(join(control, "connections"))).toEqual([]);
    db.close();
  });

  test("a retained writer cannot write after discard", async () => {
    const control = temporary();
    const store = new ConnectionStateStore(control);
    const enrollment = store.begin();
    store.discard(enrollment.pending);
    await expect(
      enrollment.writer.write(new TextEncoder().encode("late-token")),
    ).rejects.toThrow();
    expect(readdirSync(join(control, "connections"))).toEqual([]);
  });

  test("raw SQLite never contains state bytes", async () => {
    const directory = temporary();
    const db = openLedger(join(directory, "ledger.sqlite"));
    const store = new ConnectionStateStore(directory);
    const token = "access-refresh-token-and-pin";
    const saved = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode(token));
        return { display: "safe" };
      }),
      io,
    );
    expect(
      new TextDecoder().decode(readFileSync(join(directory, "ledger.sqlite"))),
    ).not.toContain(token);
    expect(
      new TextDecoder().decode(store.read(saved) ?? new Uint8Array()),
    ).toBe(token);
    db.close();
  });

  test("OAuth-like replacement is an atomic state-file swap with one source", async () => {
    const directory = temporary();
    const db = openLedger(join(directory, "ledger.sqlite"));
    const store = new ConnectionStateStore(directory);
    const first = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("old-oauth-token"));
        return { display: "first" };
      }),
      io,
    );
    const replaced = await store.replace(
      db,
      first,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("new-oauth-token"));
        return { display: "second" };
      }),
      io,
    );
    expect(replaced.source_key).toBe(first.source_key);
    expect(listConnections(db)).toHaveLength(1);
    expect(
      new TextDecoder().decode(store.read(replaced) ?? new Uint8Array()),
    ).toBe("new-oauth-token");
    const sqlite = new TextDecoder().decode(
      readFileSync(join(directory, "ledger.sqlite")),
    );
    expect(sqlite).not.toContain("old-oauth-token");
    expect(sqlite).not.toContain("new-oauth-token");
    db.close();
  });

  test("a failed replacement preserves old state and cleans staged artifacts", async () => {
    const db = openLedger(":memory:");
    const control = temporary();
    const store = new ConnectionStateStore(control);
    const first = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("old-working-token"));
        return { display: "first" };
      }),
      io,
    );
    db.exec(
      "CREATE TRIGGER reject_connection_update BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT, 'forced update failure'); END",
    );
    await expect(
      store.replace(
        db,
        first,
        connector(async (_io, state) => {
          await state.write(new TextEncoder().encode("new-failed-token"));
          return { display: "second" };
        }),
        io,
      ),
    ).rejects.toThrow("forced update failure");
    expect(
      new TextDecoder().decode(store.read(first) ?? new Uint8Array()),
    ).toBe("old-working-token");
    expect(getConnection(db, first.connector_id, first.source_key)).toEqual(first);
    expect(readdirSync(join(control, "connections"))).toEqual([
      `${first.source_key}.state`,
    ]);
    db.close();
  });

  test("replacement without new state fails closed and preserves old state", async () => {
    const db = openLedger(":memory:");
    const control = temporary();
    const store = new ConnectionStateStore(control);
    const first = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("old-required-token"));
        return { display: "first" };
      }),
      io,
    );

    await expect(
      store.replace(
        db,
        first,
        connector(async () => ({ display: "missing-state" })),
        io,
      ),
    ).rejects.toThrow("replacement sign-in did not provide connection state");

    expect(getConnection(db, first.connector_id, first.source_key)).toEqual(first);
    expect(
      new TextDecoder().decode(store.read(first) ?? new Uint8Array()),
    ).toBe("old-required-token");
    expect(readdirSync(join(control, "connections"))).toEqual([
      `${first.source_key}.state`,
    ]);
    db.close();
  });

  test("only one replacement capability can be active for a source", async () => {
    const db = openLedger(":memory:");
    const control = temporary();
    const store = new ConnectionStateStore(control);
    const first = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("initial-state"));
        return { display: "first" };
      }),
      io,
    );

    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const firstReplacement = store.replace(
      db,
      first,
      connector(async (_io, state) => {
        entered?.();
        await releasePromise;
        await state.write(new TextEncoder().encode("replacement-one"));
        return { display: "one" };
      }),
      io,
    );
    await enteredPromise;

    await expect(
      store.replace(
        db,
        first,
        connector(async (_io, state) => {
          await state.write(new TextEncoder().encode("replacement-two"));
          return { display: "two" };
        }),
        io,
      ),
    ).rejects.toThrow("connection state enrollment is already active");

    release?.();
    const replaced = await firstReplacement;
    expect(
      new TextDecoder().decode(store.read(replaced) ?? new Uint8Array()),
    ).toBe("replacement-one");
    db.close();
  });

  test("replacement timestamps advance past the persisted identity", async () => {
    const db = openLedger(":memory:");
    const control = temporary();
    const store = new ConnectionStateStore(control);
    const first = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("clock-old"));
        return { display: "first" };
      }),
      io,
    );
    const future = "2999-01-01T00:00:00.000Z";
    db.query(
      "UPDATE connections SET connected_at = ? WHERE connector_id = ? AND source_key = ?",
    ).run(future, first.connector_id, first.source_key);
    const persisted = getConnection(db, first.connector_id, first.source_key);
    if (persisted === null) throw new Error("fixture connection disappeared");

    const replaced = await store.replace(
      db,
      persisted,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("clock-new"));
        return { display: "second" };
      }),
      io,
    );

    expect(Date.parse(replaced.connected_at)).toBe(Date.parse(future) + 1);
    db.close();
  });

  test("replacement rejects a fabricated connection before staging state", async () => {
    const db = openLedger(":memory:");
    const control = temporary();
    const store = new ConnectionStateStore(control);
    const sourceKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const fabricated = {
      connector_id: "fixture",
      source_key: sourceKey,
      config: {
        schema: "kizuki.connection-config/v1" as const,
        state_ref_index: 0 as const,
      },
      secret_refs: [`file:connections/${sourceKey}.state`],
      connected_at: new Date().toISOString(),
      disconnected_at: null,
    };
    await expect(
      store.replace(
        db,
        fabricated,
        connector(async (_io, state) => {
          await state.write(new TextEncoder().encode("attacker-state"));
          return { display: "bad" };
        }),
        io,
      ),
    ).rejects.toThrow();
    expect(getConnection(db, "fixture", sourceKey)).toBeNull();
    expect(readdirSync(join(control, "connections"))).toEqual([]);
    db.close();
  });

  test("recovery restores an interrupted pre-commit replacement", async () => {
    const db = openLedger(":memory:");
    const control = temporary();
    const store = new ConnectionStateStore(control);
    const first = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("crash-old-token"));
        return { display: "first" };
      }),
      io,
    );
    const finalName = `${first.source_key}.state`;
    const finalPath = join(store.directory, finalName);
    const backupName = `${finalName}.crash.rollback`;
    renameSync(finalPath, join(store.directory, backupName));
    writeFileSync(finalPath, "crash-new-token");
    writeFileSync(
      join(store.directory, `${finalName}.crash.journal`),
      JSON.stringify({
        schema: "kizuki.connection-state-swap/v1",
        connector_id: first.connector_id,
        source_key: first.source_key,
        connected_at: "2998-01-01T00:00:00.000Z",
        final_name: finalName,
        backup_name: backupName,
      }),
    );
    store.recover(db);
    expect(
      new TextDecoder().decode(store.read(first) ?? new Uint8Array()),
    ).toBe("crash-old-token");
    expect(readdirSync(store.directory)).toEqual([finalName]);
    db.close();
  });

  test("recovery keeps the original state when a crash precedes the first rename", async () => {
    const db = openLedger(":memory:");
    const control = temporary();
    const store = new ConnectionStateStore(control);
    const first = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("pre-rename-old-token"));
        return { display: "first" };
      }),
      io,
    );
    const finalName = `${first.source_key}.state`;
    const backupName = `${finalName}.planned.rollback`;
    writeFileSync(
      join(store.directory, `${finalName}.planned.journal`),
      JSON.stringify({
        schema: "kizuki.connection-state-swap/v1",
        connector_id: first.connector_id,
        source_key: first.source_key,
        connected_at: "2997-01-01T00:00:00.000Z",
        final_name: finalName,
        backup_name: backupName,
      }),
    );

    store.recover(db);

    expect(
      new TextDecoder().decode(store.read(first) ?? new Uint8Array()),
    ).toBe("pre-rename-old-token");
    expect(readdirSync(store.directory)).toEqual([finalName]);
    db.close();
  });

  test("forged handles and malformed rows fail closed", () => {
    const db = openLedger(":memory:");
    const source = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const store = new ConnectionStateStore(temporary());
    expect(() =>
      (
        store as unknown as {
          save(db: unknown, connector: string, handle: unknown): void;
        }
      ).save(db, "fixture", {
        sourceKey: source,
        ref: "file:/etc/passwd",
        finalPath: "/etc/passwd",
        temporaryPath: null,
        written: true,
      }),
    ).toThrow(LedgerError);
    expect(() =>
      db
        .query(
          "INSERT INTO connections (connector_id, source_key, config, secret_refs, connected_at, disconnected_at) VALUES (?, ?, ?, ?, ?, NULL)",
        )
        .run(
          "fixture",
          source,
          '{"schema":"kizuki.connection-config/v1","state_ref_index":0}',
          '["file:/etc/passwd"]',
          new Date().toISOString(),
        ),
    ).toThrow();
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.query(
      "INSERT INTO connections (connector_id, source_key, config, secret_refs, connected_at, disconnected_at) VALUES (?, ?, ?, ?, ?, NULL)",
    ).run(
      "fixture",
      source,
      '{"schema":"kizuki.connection-config/v1","state_ref_index":null}',
      "[]",
      new Date().toISOString(),
    );
    expect(getConnection(db, "fixture", source)?.config.state_ref_index).toBeNull();
    db.query(
      "UPDATE connections SET secret_refs = ? WHERE connector_id = ? AND source_key = ?",
    ).run('["file:/etc/passwd"]', "fixture", source);
    expect(() => getConnection(db, "fixture", source)).toThrow(LedgerError);
    db.close();
  });

  test("SQLite itself refuses arbitrary config", () => {
    const db = openLedger(":memory:");
    expect(() =>
      db
        .query(
          "INSERT INTO connections (connector_id, source_key, config, secret_refs, connected_at, disconnected_at) VALUES (?, ?, ?, ?, ?, NULL)",
        )
        .run(
          "fixture",
          "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          '{"session_id":"ordinary-plaintext-credential"}',
          "[]",
          new Date().toISOString(),
        ),
    ).toThrow();
    db.close();
  });
});

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

    const sqlite = new TextDecoder().decode(
      readFileSync(join(directory, "ledger.sqlite")),
    );
    for (const secret of [
      "SENTINEL-ACCESS",
      "SENTINEL-REFRESH",
      "SENTINEL-SECOND",
      "SENTINEL-ROTATED",
    ]) {
      expect(sqlite).not.toContain(secret);
    }
    db.close();
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
    await expect(resolve("env:FIXTURE_TOKEN")).rejects.toThrow(LedgerError);
    db.close();
  });
});
