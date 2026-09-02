import { afterEach, describe, expect, test } from "bun:test";
import {
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ConnectionStateStore,
  enrollConnection,
  writeAll,
} from "../src/ledger/connection-state";
import {
  LedgerError,
  getConnection,
  listConnections,
} from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";
import { connector, io, temporaryDirectories } from "./connections-helpers";

const { temporary, cleanup } = temporaryDirectories("kizuki-connection-state-");

afterEach(cleanup);

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
