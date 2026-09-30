import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Connector,
  Manifest,
  RunContext,
  SyncBatch,
} from "../src/contracts/connector";
import {
  MAX_CURSOR_BYTES,
  MAX_CURSOR_STORE_BYTES,
  MAX_CURSOR_STORE_ENTRIES,
  MAX_CURSOR_STORE_KEY_BYTES,
  freezeManifest,
} from "../src/contracts/connector";
import { runBackfill, runSync, runToCompletion } from "../src/ingest/run";
import {
  getCheckpoint,
  listConnectionRuns,
  registerConnection,
} from "../src/ledger/connections";
import { readCursorStore } from "../src/ledger/cursor-store";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../src/ledger/db";
import { CURSOR_STORE_MIGRATION_VERSION } from "../src/world/tables/versions";
import { setSourceGrant } from "../src/ledger/source-grants";
import { initStaging } from "../src/staging/proposals";
import { validEvent } from "./fixtures";

const SOURCE = "01JJ0000000000000000000001";
const OTHER = "01JJ0000000000000000000002";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function database(): Database {
  const db = openLedger(":memory:");
  initStaging(db);
  for (const key of [SOURCE, OTHER]) {
    registerConnection(db, "fixture", key, { implementation_version: "1.0.0" });
    setSourceGrant(db, {
      source_key: key,
      expected_revision: 0,
      operation_id: `grant-${key}`,
      policy: {
        purposes: ["capture", "recall", "derive"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        sensitivity_floor: "public",
      },
    });
  }
  return db;
}

function manifest(hosted: boolean): Manifest {
  return freezeManifest({
    schema: "kizuki.connector/v1",
    connector_id: "fixture",
    version: "1.0.0",
    kinds: ["message"],
    capabilities: {
      backfill: true,
      sync: true,
      tombstones: false,
      purge: false,
      fixture: false,
      ...(hosted ? { cursor_store: "host" as const } : {}),
    },
    required_secrets: [],
    emits_sensitivity_hint: false,
    auth_modes: ["none"],
  });
}

interface Scripted {
  connector: Connector;
  seen: (RunContext | undefined)[];
}

/** Returns each scripted batch in turn and records what the host lent it. */
function scripted(hosted: boolean, batches: SyncBatch[]): Scripted {
  const seen: (RunContext | undefined)[] = [];
  let index = 0;
  const next = async (...args: unknown[]): Promise<SyncBatch> => {
    seen.push(args[1] as RunContext | undefined);
    const batch = batches[Math.min(index, batches.length - 1)];
    index += 1;
    if (batch === undefined) throw new Error("no scripted batch");
    return batch;
  };
  const connector: Connector = {
    manifest: () => manifest(hosted),
    health: async () => {
      throw new Error("unused");
    },
    connect: async () => undefined,
    backfill: next,
    sync: next,
    revoke: async () => undefined,
    purgeSource: async () => ({
      subject_id: "",
      source_record_ids: [],
      unreachable_source_record_ids: [],
    }),
    fixture: async () => [],
  };
  return { connector, seen };
}

const filler = (bytes: number): string => "x".repeat(bytes);

describe("host-backed cursor store", () => {
  test("the committed map is lent to the next call and the wire cursor stays small", async () => {
    const db = database();
    const map: Record<string, string> = {};
    for (let index = 0; index < 5_000; index += 1)
      map[`peer-${index}`] = `user:${index}:1`;
    const first = scripted(true, [
      {
        events: [{ ...validEvent(), source_record_id: "a" }],
        cursor: "digest-1",
        cursor_store: map,
        has_more: true,
      },
    ]);
    const result = await runBackfill(db, first.connector, "fixture", SOURCE);
    expect(result.errors).toEqual([]);
    expect(result.stored).toBe(1);
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBe("digest-1");
    // Far more than a checkpoint may carry, held beside it.
    const stored = readCursorStore(db, "fixture", SOURCE);
    expect(stored.size).toBe(5_000);
    expect(stored.get("peer-4999")).toBe("user:4999:1");
    expect(JSON.stringify(map).length).toBeGreaterThan(MAX_CURSOR_BYTES);
    expect(first.seen[0]?.cursor_store.size).toBe(0);

    const second = scripted(true, [
      {
        events: [],
        cursor: "digest-2",
        cursor_store: { "peer-0": "user:0:2", "peer-1": null },
        has_more: false,
      },
    ]);
    await runSync(db, second.connector, "fixture", SOURCE);
    expect(second.seen[0]?.cursor_store.size).toBe(5_000);
    expect(second.seen[0]?.cursor_store.get("peer-1")).toBe("user:1:1");
    const after = readCursorStore(db, "fixture", SOURCE);
    expect(after.size).toBe(4_999);
    expect(after.get("peer-0")).toBe("user:0:2");
    expect(after.has("peer-1")).toBe(false);
  });

  test("a map belongs to one connection", async () => {
    const db = database();
    await runBackfill(
      db,
      scripted(true, [
        { events: [], cursor: "c", cursor_store: { k: "v" }, has_more: false },
      ]).connector,
      "fixture",
      SOURCE,
    );
    expect(readCursorStore(db, "fixture", SOURCE).get("k")).toBe("v");
    expect(readCursorStore(db, "fixture", OTHER).size).toBe(0);
    const probe = scripted(true, [{ events: [], cursor: null }]);
    await runBackfill(db, probe.connector, "fixture", OTHER);
    expect(probe.seen[0]?.cursor_store.size).toBe(0);
  });

  test("the map and the checkpoint commit in one transaction", async () => {
    const db = database();
    await runBackfill(
      db,
      scripted(true, [
        { events: [], cursor: "c1", cursor_store: { a: "1" }, has_more: true },
      ]).connector,
      "fixture",
      SOURCE,
    );
    // The run receipt is the last write of the checkpoint transaction. If it
    // cannot be written, neither the new cursor nor the new map may survive.
    db.exec(`CREATE TRIGGER refuse_receipt BEFORE INSERT ON connection_runs
             BEGIN SELECT RAISE(ABORT, 'receipt refused'); END`);
    await expect(
      runBackfill(
        db,
        scripted(true, [
          {
            events: [],
            cursor: "c2",
            cursor_store: { a: "2", b: "3" },
            has_more: true,
          },
        ]).connector,
        "fixture",
        SOURCE,
      ),
    ).rejects.toThrow("receipt refused");
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBe("c1");
    expect([...readCursorStore(db, "fixture", SOURCE)]).toEqual([["a", "1"]]);
  });

  test("a run that does not commit its cursor does not move the map", async () => {
    const db = database();
    await runBackfill(
      db,
      scripted(true, [
        { events: [], cursor: "c1", cursor_store: { a: "1" }, has_more: true },
      ]).connector,
      "fixture",
      SOURCE,
    );
    const failing = await runBackfill(
      db,
      scripted(true, [
        {
          events: [{ ...validEvent(), text: 1 as unknown as string }],
          cursor: "c2",
          cursor_store: { a: "2" },
          has_more: true,
        },
      ]).connector,
      "fixture",
      SOURCE,
    );
    expect(failing.errors.length).toBeGreaterThan(0);
    expect(listConnectionRuns(db, "fixture", SOURCE).at(-1)?.status).toBe(
      "failed",
    );
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBe("c1");
    expect(readCursorStore(db, "fixture", SOURCE).get("a")).toBe("1");

    const unavailable = await runBackfill(
      db,
      scripted(true, [
        {
          events: [],
          cursor: "c3",
          cursor_store: { a: "3" },
          status: "unavailable",
          detail: "down",
        },
      ]).connector,
      "fixture",
      SOURCE,
    );
    expect(unavailable.errors).toEqual(["down"]);
    expect(readCursorStore(db, "fixture", SOURCE).get("a")).toBe("1");
  });

  test("the map is capped at one MiB across batches and an oversized delta stores nothing", async () => {
    const db = database();
    const chunk = Math.floor(MAX_CURSOR_STORE_BYTES / 3) - 16;
    for (const key of ["a", "b", "c"]) {
      const ok = await runBackfill(
        db,
        scripted(true, [
          {
            events: [],
            cursor: `after-${key}`,
            cursor_store: { [key]: filler(chunk) },
            has_more: true,
          },
        ]).connector,
        "fixture",
        SOURCE,
      );
      expect(ok.errors).toEqual([]);
    }
    const before = readCursorStore(db, "fixture", SOURCE);
    const overflow = await runBackfill(
      db,
      scripted(true, [
        {
          events: [{ ...validEvent(), source_record_id: "kept-out" }],
          cursor: "after-d",
          cursor_store: { d: filler(64 * 1024) },
          has_more: true,
        },
      ]).connector,
      "fixture",
      SOURCE,
    );
    expect(overflow.stored).toBe(0);
    expect(overflow.errors).toEqual([
      `cursor_store would exceed ${MAX_CURSOR_STORE_BYTES} bytes`,
    ]);
    expect(listConnectionRuns(db, "fixture", SOURCE).at(-1)?.status).toBe(
      "refused",
    );
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBe("after-c");
    expect([...readCursorStore(db, "fixture", SOURCE)]).toEqual([...before]);

    // Deleting entries makes room again.
    const freed = await runBackfill(
      db,
      scripted(true, [
        {
          events: [],
          cursor: "after-e",
          cursor_store: { a: null, d: filler(64 * 1024) },
          has_more: true,
        },
      ]).connector,
      "fixture",
      SOURCE,
    );
    expect(freed.errors).toEqual([]);
    expect(readCursorStore(db, "fixture", SOURCE).has("a")).toBe(false);
  });

  test("a single delta over the bound is refused before it is stored", async () => {
    const db = database();
    const tooBig = await runBackfill(
      db,
      scripted(true, [
        {
          events: [],
          cursor: "c",
          cursor_store: { big: filler(MAX_CURSOR_STORE_BYTES + 1) },
          has_more: true,
        },
      ]).connector,
      "fixture",
      SOURCE,
    );
    expect(tooBig.errors.length).toBe(1);
    expect(readCursorStore(db, "fixture", SOURCE).size).toBe(0);
    const many: Record<string, string> = {};
    for (let index = 0; index <= MAX_CURSOR_STORE_ENTRIES; index += 1)
      many[`k${index}`] = "v";
    const tooMany = await runBackfill(
      db,
      scripted(true, [
        { events: [], cursor: "c", cursor_store: many, has_more: true },
      ]).connector,
      "fixture",
      SOURCE,
    );
    expect(tooMany.errors).toEqual(["cursor_store could not be read as plain data"]);
    expect(readCursorStore(db, "fixture", SOURCE).size).toBe(0);
  });

  test("the wire cursor keeps its own bound", async () => {
    const db = database();
    const result = await runBackfill(
      db,
      scripted(true, [
        {
          events: [],
          cursor: filler(MAX_CURSOR_BYTES + 1),
          cursor_store: { k: "v" },
          has_more: true,
        },
      ]).connector,
      "fixture",
      SOURCE,
    );
    expect(result.errors).toEqual(["cursor exceeds maximum cursor size"]);
    expect(readCursorStore(db, "fixture", SOURCE).size).toBe(0);
  });

  test("a delta without the manifest declaration is refused", async () => {
    const db = database();
    const result = await runBackfill(
      db,
      scripted(false, [
        {
          events: [{ ...validEvent(), source_record_id: "x" }],
          cursor: "c",
          cursor_store: { k: "v" },
        },
      ]).connector,
      "fixture",
      SOURCE,
    );
    expect(result.stored).toBe(0);
    expect(result.errors).toEqual([
      "batch carries cursor_store without the manifest capability",
    ]);
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBeNull();
    expect(readCursorStore(db, "fixture", SOURCE).size).toBe(0);
  });

  test("a connector that did not declare the capability is called as before", async () => {
    const db = database();
    const legacy = scripted(false, [{ events: [], cursor: "c" }]);
    await runBackfill(db, legacy.connector, "fixture", SOURCE);
    await runSync(db, legacy.connector, "fixture", SOURCE);
    expect(legacy.seen).toEqual([undefined, undefined]);
  });

  test("malformed deltas are refused without echoing their content", async () => {
    const db = database();
    const secret = "canary-value";
    const hostile: Record<string, unknown>[] = [
      { [secret]: 1 },
      { [secret]: { nested: secret } },
      { "": secret },
      { [filler(MAX_CURSOR_STORE_KEY_BYTES + 1)]: secret },
      JSON.parse(`{"__proto__": "${secret}"}`) as Record<string, unknown>,
      Object.defineProperty({}, secret, {
        enumerable: true,
        get: () => secret,
      }),
    ];
    for (const delta of hostile) {
      const result = await runBackfill(
        db,
        scripted(true, [
          {
            events: [],
            cursor: "c",
            cursor_store: delta as never,
            has_more: true,
          },
        ]).connector,
        "fixture",
        SOURCE,
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).not.toContain(secret);
      expect(result.stored).toBe(0);
    }
    expect(readCursorStore(db, "fixture", SOURCE).size).toBe(0);
    for (const bad of ["text", ["a"], 7]) {
      const result = await runBackfill(
        db,
        scripted(true, [
          { events: [], cursor: "c", cursor_store: bad as never },
        ]).connector,
        "fixture",
        SOURCE,
      );
      expect(result.errors).toHaveLength(1);
    }
  });

  test("runToCompletion drains a source whose wire cursor never grows", async () => {
    const db = database();
    const batches: SyncBatch[] = [];
    for (let index = 0; index < 20; index += 1) {
      batches.push({
        events: [{ ...validEvent(), source_record_id: `r${index}` }],
        cursor: `digest-${index}`,
        cursor_store: { [`dialog-${index}`]: filler(30_000) },
        has_more: index < 19,
      });
    }
    const result = await runToCompletion(
      db,
      scripted(true, batches).connector,
      "fixture",
      SOURCE,
      "backfill",
    );
    expect(result.errors).toEqual([]);
    expect(result.stored).toBe(20);
    expect(readCursorStore(db, "fixture", SOURCE).size).toBe(20);
    expect(getCheckpoint(db, "fixture", SOURCE)?.backfill_complete).toBe(true);
  });

  test('a manifest may only declare the host store as "host"', () => {
    expect(() =>
      freezeManifest({
        ...manifest(true),
        capabilities: {
          ...manifest(true).capabilities,
          cursor_store: "sqlite" as never,
        },
      }),
    ).toThrow(TypeError);
  });
});

describe("cursor-store ledger migration", () => {
  test("a fresh database has the table at the current version", () => {
    const db = openLedger(":memory:");
    expect(LEDGER_SCHEMA_VERSION).toBeGreaterThanOrEqual(CURSOR_STORE_MIGRATION_VERSION);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE name = 'connector_cursor_store'",
        )
        .get(),
    ).not.toBeNull();
    db.close();
  });

  test("the previous database version upgrades, keeps its checkpoints, and gains an empty map", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-cursor-store-"));
    directories.push(directory);
    const path = join(directory, "kizuki.db");
    const first = openLedger(path);
    registerConnection(first, "fixture", SOURCE);
    first
      .query(
        `INSERT INTO checkpoints (connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result, backfill_complete, backfill_cursor, sync_cursor)
       VALUES ('fixture', ?, 'kept', 'backfill', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
               '{"stored":0,"duplicates":0,"errors":[],"proposals_created":0,"withdrawn":0,"retractions_filed":0,"cursor":"kept"}', 0, 'kept', NULL)`,
      )
      .run(SOURCE);
    first.exec("DROP TABLE connector_cursor_store");
    first.query("UPDATE schema_version SET version = ?").run(CURSOR_STORE_MIGRATION_VERSION - 1);
    first.close();

    const upgraded = openLedger(path);
    try {
      expect(
        upgraded
          .query<{ version: number }, []>("SELECT version FROM schema_version")
          .get()?.version,
      ).toBe(LEDGER_SCHEMA_VERSION);
      expect(getCheckpoint(upgraded, "fixture", SOURCE)?.cursor).toBe("kept");
      expect(readCursorStore(upgraded, "fixture", SOURCE).size).toBe(0);
      upgraded
        .query(
          "INSERT INTO connector_cursor_store (connector_id, source_key, key, value, bytes) VALUES ('fixture', ?, 'k', 'v', 2)",
        )
        .run(SOURCE);
      expect(readCursorStore(upgraded, "fixture", SOURCE).get("k")).toBe("v");
      expect(() =>
        upgraded
          .query(
            "INSERT INTO connector_cursor_store (connector_id, source_key, key, value, bytes) VALUES ('fixture', ?, 'k', 'v', 2)",
          )
          .run(OTHER),
      ).toThrow();
    } finally {
      upgraded.close();
    }
  });
});
