import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Connector, Manifest, SyncBatch } from "../src/contracts/connector";
import {
  MAX_CURSOR_BYTES,
  MAX_SYNC_BATCH_EVENTS,
} from "../src/contracts/connector";
import { KizukiError } from "../src/contracts/errors";
import type { CaptureEventInput } from "../src/contracts/event";
import { enrollConnection } from "../src/ledger/enroll";
import {
  LedgerError,
  disconnect,
  getCheckpoint,
  getConnection,
  inspectConnections,
  listConnectionRuns,
  listConnections,
  registerConnection,
  saveCheckpoint,
} from "../src/ledger/connections";
import { ConnectionStateStore } from "../src/ledger/connection-state";
import { isCoreUlid, journalSourceKey } from "../src/ledger/connection-state-files";
import { openLedger } from "../src/ledger/db";
import { scopedSecretResolver } from "../src/ledger/secret-scope";
import { assertConnectorBrowserUrl } from "../src/ledger/sign-in-guard";
import { runBackfill, runSync } from "../src/ingest/run";
import { initStaging } from "../src/staging/proposals";
import { DeadlineError, withDeadline } from "../src/util/deadline";
import { sha256Hex } from "../src/util/hash";
import { connector, io, temporaryDirectories } from "./connections-helpers";
import { validEvent } from "./fixtures";

const SOURCE = "01JJ0000000000000000000001";
const { temporary, cleanup } = temporaryDirectories("kizuki-connections-p1-");

afterEach(cleanup);

describe("canonical connection identifiers", () => {
  test("accepts the 128-bit ULID boundaries and rejects impossible high digits", () => {
    const db = openLedger(":memory:");
    try {
      for (const key of ["00000000000000000000000000", "7ZZZZZZZZZZZZZZZZZZZZZZZZZ"]) {
        expect(registerConnection(db, "fixture", key).source_key).toBe(key);
        expect(isCoreUlid(key)).toBe(true);
        expect(journalSourceKey(`${key}.state.${key}.journal`)).toBe(key);
      }
      for (const first of "89ABCDEFGHJKMNPQRSTVWXYZ") {
        const key = first + "0".repeat(25);
        expect(() => registerConnection(db, "fixture", key)).toThrow(LedgerError);
        expect(isCoreUlid(key)).toBe(false);
        expect(journalSourceKey(`${key}.state.${SOURCE}.journal`)).toBeNull();
        expect(journalSourceKey(`${SOURCE}.state.${key}.journal`)).toBeNull();
      }
      expect(listConnections(db)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("refuses a non-canonical key persisted by an older schema", () => {
    const db = openLedger(":memory:");
    try {
      registerConnection(db, "fixture", SOURCE);
      const invalid = "8" + "0".repeat(25);
      db.query("UPDATE connections SET source_key = ? WHERE source_key = ?").run(invalid, SOURCE);
      expect(() => getConnection(db, "fixture", invalid)).toThrow(LedgerError);
      expect(inspectConnections(db)).toEqual([
        { ok: false, connector_id: "fixture", source_key: invalid, error: "connection source_key is not core-generated" },
      ]);
    } finally {
      db.close();
    }
  });
});

function database() {
  const db = openLedger(":memory:");
  initStaging(db);
  registerConnection(db, "fixture", SOURCE, { implementation_version: "1.0.0" });
  return db;
}

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    schema: "kizuki.connector/v1",
    connector_id: "fixture",
    version: "1.0.0",
    kinds: ["message"],
    capabilities: {
      backfill: true,
      sync: true,
      tombstones: true,
      purge: true,
      fixture: true,
    },
    required_secrets: [],
    emits_sensitivity_hint: false,
    auth_modes: ["none"],
    ...over,
  };
}

function stub(over: {
  backfill?: () => Promise<SyncBatch>;
  sync?: () => Promise<SyncBatch>;
  declared?: Partial<Manifest>;
}): Connector {
  return {
    manifest: () => manifest(over.declared),
    health: async () => {
      throw new Error("unused");
    },
    connect: async () => undefined,
    backfill: over.backfill ?? (async () => ({ events: [], cursor: null })),
    sync: over.sync ?? (async () => ({ events: [], cursor: null })),
    revoke: async () => undefined,
    purgeSource: async () => ({
      subject_id: "",
      source_record_ids: [],
      unreachable_source_record_ids: [],
    }),
    fixture: async () => [],
  };
}

describe("ingest capability, budget, and unavailable", () => {
  test("refuses a mode the manifest does not declare", async () => {
    const db = database();
    const result = await runBackfill(
      db,
      stub({ declared: { capabilities: { ...manifest().capabilities, backfill: false } } }),
      "fixture",
      SOURCE,
    );
    expect(result.errors).toEqual(["fixture: manifest does not declare backfill"]);
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBeNull();
    expect(listConnectionRuns(db, "fixture", SOURCE)[0]?.status).toBe("refused");
    db.close();
  });

  test("refuses a batch over the event budget before accept", async () => {
    const db = database();
    const events: CaptureEventInput[] = [];
    for (let index = 0; index < MAX_SYNC_BATCH_EVENTS + 1; index += 1) {
      events.push({ ...validEvent(), source_record_id: `rec-${index}` });
    }
    const result = await runBackfill(
      db,
      stub({ backfill: async () => ({ events, cursor: "next" }) }),
      "fixture",
      SOURCE,
    );
    expect(result.stored).toBe(0);
    expect(result.errors[0]).toContain("exceeds");
    expect(getCheckpoint(db, "fixture", SOURCE)?.last_result.cursor).toBeNull();
    db.close();
  });

  test("an unavailable batch does not advance the cursor", async () => {
    const db = database();
    await runBackfill(
      db,
      stub({ backfill: async () => ({ events: [validEvent()], cursor: "page-1" }) }),
      "fixture",
      SOURCE,
    );
    const result = await runSync(
      db,
      stub({
        sync: async () => ({
          events: [],
          cursor: "page-2",
          status: "unavailable",
          detail: "provider is down",
        }),
      }),
      "fixture",
      SOURCE,
    );
    expect(result.errors).toEqual(["provider is down"]);
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBe("page-1");
    expect(getCheckpoint(db, "fixture", SOURCE)?.last_result.cursor).toBe("page-1");
    expect(listConnectionRuns(db, "fixture", SOURCE).at(-1)?.status).toBe("unavailable");
    db.close();
  });

  test("a thrown connector error is a failed run receipt, not silence", async () => {
    const db = database();
    const result = await runBackfill(
      db,
      stub({
        backfill: async () => {
          throw new KizukiError("unreachable", "the source is unreachable");
        },
      }),
      "fixture",
      SOURCE,
    );
    expect(result.errors).toEqual(["the source is unreachable"]);
    expect(listConnectionRuns(db, "fixture", SOURCE)).toHaveLength(1);
    expect(listConnectionRuns(db, "fixture", SOURCE)[0]?.status).toBe("unavailable");
    db.close();
  });

  test("a thrown non-typed error is a failed run receipt", async () => {
    const db = database();
    const result = await runBackfill(
      db,
      stub({
        backfill: async () => {
          throw new Error("connector panicked");
        },
      }),
      "fixture",
      SOURCE,
    );
    expect(result.errors).toEqual(["connector panicked"]);
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBeNull();
    expect(listConnectionRuns(db, "fixture", SOURCE)[0]?.status).toBe("failed");
    db.close();
  });

  test("an infrastructure accept failure aborts the batch and does not advance the cursor", async () => {
    const db = database();
    await runBackfill(
      db,
      stub({ backfill: async () => ({ events: [validEvent()], cursor: "page-1" }) }),
      "fixture",
      SOURCE,
    );
    db.exec(`
      CREATE TRIGGER fail_events_insert BEFORE INSERT ON events
      BEGIN
        SELECT RAISE(ABORT, 'SQLITE_IOERR disk I/O error');
      END;
    `);
    const result = await runSync(
      db,
      stub({
        sync: async () => ({
          events: [
            { ...validEvent(), source_record_id: "rec-2" },
            { ...validEvent(), source_record_id: "rec-3" },
          ],
          cursor: "page-2",
        }),
      }),
      "fixture",
      SOURCE,
    );
    expect(result.stored).toBe(0);
    expect(result.errors.some((error) => error.includes("SQLITE_IOERR"))).toBe(true);
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBe("page-1");
    expect(getCheckpoint(db, "fixture", SOURCE)?.last_result.cursor).toBe("page-1");
    expect(listConnectionRuns(db, "fixture", SOURCE).at(-1)?.status).toBe("failed");
    db.close();
  });

  test("last_result.cursor stays at the committed cursor after a validation error", async () => {
    const db = database();
    const result = await runBackfill(
      db,
      stub({
        backfill: async () => ({
          events: [{ ...validEvent(), occurred_at: "not-a-time" }],
          cursor: "attempted",
        }),
      }),
      "fixture",
      SOURCE,
    );
    const checkpoint = getCheckpoint(db, "fixture", SOURCE);
    expect(result.errors).toHaveLength(1);
    expect(checkpoint?.cursor).toBeNull();
    expect(checkpoint?.last_result.cursor).toBeNull();
    db.close();
  });

  test("an oversized cursor is refused before persist", async () => {
    const db = database();
    const cursor = "x".repeat(MAX_CURSOR_BYTES + 1);
    const result = await runBackfill(
      db,
      stub({ backfill: async () => ({ events: [validEvent()], cursor }) }),
      "fixture",
      SOURCE,
    );
    expect(result.stored).toBe(0);
    expect(result.errors[0]).toContain("cursor");
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBeNull();
    db.close();
  });

  test("a checkpoint write without an active connection is refused", () => {
    const db = openLedger(":memory:");
    expect(() =>
      saveCheckpoint(db, "fixture", SOURCE, "next", "sync", {
        stored: 0,
        duplicates: 0,
        errors: [],
        proposals_created: 0,
        withdrawn: 0,
        retractions_filed: 0,
        cursor: "next",
      }),
    ).toThrow("active connection");
    db.close();
  });

  test("a disconnected connection cannot receive a checkpoint", () => {
    const db = database();
    disconnect(db, "fixture", SOURCE);
    expect(() =>
      saveCheckpoint(db, "fixture", SOURCE, "next", "sync", {
        stored: 0,
        duplicates: 0,
        errors: [],
        proposals_created: 0,
        withdrawn: 0,
        retractions_filed: 0,
        cursor: "next",
      }),
    ).toThrow("active connection");
    db.close();
  });

  test("one corrupt connection row does not hide the others", () => {
    const db = database();
    const other = "01JJ0000000000000000000002";
    registerConnection(db, "other", other);
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.query(
      "UPDATE connections SET secret_refs = ? WHERE connector_id = ? AND source_key = ?",
    ).run('["file:/etc/passwd"]', "fixture", SOURCE);
    const listed = listConnections(db);
    expect(listed.map((row) => row.connector_id)).toEqual(["other"]);
    const inspected = inspectConnections(db);
    expect(inspected.some((item) => !item.ok && item.connector_id === "fixture")).toBe(true);
    db.close();
  });

  test("strict checkpoint decode refuses unexpected last_result keys", () => {
    const db = database();
    saveCheckpoint(db, "fixture", SOURCE, "next", "sync", {
      stored: 1,
      duplicates: 0,
      errors: [],
      proposals_created: 0,
      withdrawn: 0,
      retractions_filed: 0,
      cursor: "next",
    });
    db.query(
      "UPDATE checkpoints SET last_result = ? WHERE connector_id = ? AND source_key = ?",
    ).run('{"stored":1,"extra":true}', "fixture", SOURCE);
    expect(() => getCheckpoint(db, "fixture", SOURCE)).toThrow(LedgerError);
    db.close();
  });
});

describe("opaque state identity, bounds, and recovery", () => {
  test("replacement refuses a connector whose manifest id differs", async () => {
    const directory = temporary();
    const db = openLedger(":memory:");
    const store = new ConnectionStateStore(directory);
    const first = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("owned-state"));
        return { display: "ada" };
      }),
      io,
    );
    await expect(
      store.replace(
        db,
        first,
        {
          ...connector(async (_io, state) => {
            await state.write(new TextEncoder().encode("stolen"));
            return { display: "bad" };
          }),
          manifest: () => ({
            ...connector(async () => ({ display: "x" })).manifest(),
            connector_id: "elsewhere",
          }),
        },
        io,
      ),
    ).rejects.toThrow("does not match the connection");
    expect(new TextDecoder().decode(store.read(first) ?? new Uint8Array())).toBe(
      "owned-state",
    );
    db.close();
  });

  test("enroll persists the implementation version", async () => {
    const db = openLedger(":memory:");
    const store = new ConnectionStateStore(temporary());
    const saved = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("token"));
        return { display: "ada" };
      }),
      io,
    );
    expect(saved.implementation_version).toBe("1");
    db.close();
  });

  test("read refuses an oversized state file", async () => {
    const directory = temporary();
    const db = openLedger(":memory:");
    const store = new ConnectionStateStore(directory);
    const saved = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("small"));
        return { display: "ada" };
      }),
      io,
    );
    writeFileSync(join(store.directory, `${saved.source_key}.state`), Buffer.alloc(1024 * 1024 + 1));
    chmodSync(join(store.directory, `${saved.source_key}.state`), 0o600);
    expect(() => store.read(saved)).toThrow("exceeds maximum size");
    db.close();
  });

  test("read refuses a symlink swap", async () => {
    const directory = temporary();
    const db = openLedger(":memory:");
    const store = new ConnectionStateStore(directory);
    const saved = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("small"));
        return { display: "ada" };
      }),
      io,
    );
    const path = join(store.directory, `${saved.source_key}.state`);
    unlinkSync(path);
    symlinkSync("/etc/passwd", path);
    expect(() => store.read(saved)).toThrow("regular file");
    db.close();
  });

  test("a second connection cannot reuse another source_key", () => {
    const db = database();
    expect(() => registerConnection(db, "other", SOURCE)).toThrow();
    db.close();
  });

  test("a malformed journal holds its source and does not block the others", async () => {
    const directory = temporary();
    const db = openLedger(":memory:");
    const store = new ConnectionStateStore(directory);
    const first = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("kept"));
        return { display: "ada" };
      }),
      io,
    );
    const second = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("other"));
        return { display: "grace" };
      }),
      io,
    );
    writeFileSync(
      join(store.directory, `${first.source_key}.state.01ARZ3NDEKTSV4RRFFQ69G5FAV.journal`),
      "not-json",
      { mode: 0o600 },
    );
    const report = store.recover(db);
    expect(report.unresolved).toHaveLength(1);
    expect(report.quarantined).toEqual([]);
    expect(() => store.read(first)).toThrow("unresolved");
    expect(new TextDecoder().decode(store.read(second) ?? new Uint8Array())).toBe("other");
    db.close();
  });

  test("a committed hash mismatch keeps the journal so read stays refused", async () => {
    const directory = temporary();
    const db = openLedger(":memory:");
    const store = new ConnectionStateStore(directory);
    const saved = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("kept"));
        return { display: "ada" };
      }),
      io,
    );
    writeFileSync(
      join(store.directory, `${saved.source_key}.state.01ARZ3NDEKTSV4RRFFQ69G5FAV.journal`),
      JSON.stringify({
        schema: "kizuki.connection-state-swap/v1",
        connector_id: saved.connector_id,
        source_key: saved.source_key,
        connected_at: saved.connected_at,
        final_name: `${saved.source_key}.state`,
        backup_name: null,
        final_sha256: "0".repeat(64),
        final_bytes: 4,
      }),
      { mode: 0o600 },
    );
    const report = store.recover(db);
    expect(report.unresolved).toHaveLength(1);
    expect(report.quarantined).toEqual([]);
    expect(() => store.read(saved)).toThrow("unresolved");
    db.close();
  });

  test("read refuses an unresolved journal", async () => {
    const directory = temporary();
    const db = openLedger(":memory:");
    const store = new ConnectionStateStore(directory);
    const saved = await enrollConnection(
      db,
      store,
      connector(async (_io, state) => {
        await state.write(new TextEncoder().encode("kept"));
        return { display: "ada" };
      }),
      io,
    );
    writeFileSync(
      join(store.directory, `${saved.source_key}.state.01ARZ3NDEKTSV4RRFFQ69G5FAV.journal`),
      JSON.stringify({
        schema: "kizuki.connection-state-swap/v1",
        connector_id: saved.connector_id,
        source_key: saved.source_key,
        connected_at: saved.connected_at,
        final_name: `${saved.source_key}.state`,
        backup_name: null,
        final_sha256: sha256Hex("kept"),
        final_bytes: 4,
      }),
      { mode: 0o600 },
    );
    expect(() => store.read(saved)).toThrow("unresolved");
    db.close();
  });
});

describe("host secret and browser guards", () => {
  test("a scoped resolver denies another connection's secret_ref", async () => {
    const resolve = scopedSecretResolver(
      ["file:connections/01JJ0000000000000000000001.state"],
      async () => "secret",
    );
    await expect(resolve("file:connections/01JJ0000000000000000000002.state")).rejects.toThrow(
      "not granted",
    );
    await expect(resolve("file:connections/01JJ0000000000000000000001.state")).resolves.toBe(
      "secret",
    );
  });

  test("browser URLs must be https or loopback http", () => {
    expect(() => assertConnectorBrowserUrl("file:///etc/passwd")).toThrow("https");
    expect(() => assertConnectorBrowserUrl("javascript:alert(1)")).toThrow();
    expect(() => assertConnectorBrowserUrl("http://example.com")).toThrow();
    expect(assertConnectorBrowserUrl("https://example.com/oauth").protocol).toBe("https:");
    expect(assertConnectorBrowserUrl("http://127.0.0.1:8753/callback").hostname).toBe(
      "127.0.0.1",
    );
  });

  test("a hung operation is a deadline, not an open wait", async () => {
    await expect(
      withDeadline(new Promise(() => undefined), 10, "sync timed out"),
    ).rejects.toBeInstanceOf(DeadlineError);
  });
});
