import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault, listClaims, setSourceGrant, registerConnection, runBackfill, runSync, runBatch, MAX_SYNC_BATCH_BYTES } from "@kizuki/core";
import { getCheckpoint } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { KizukiError } from "../src/errors";
import { InMemoryLedger } from "../src/ledger";
import {
  LEGACY_EVENTS_CONNECTOR_ID,
  createLegacyEventsConnector,
} from "../src/import-legacy-events";
import {
  LEGACY_EVENTS_FIXTURE,
  fixtureJsonl,
} from "../src/import-legacy-events/fixture";
import type { LegacyEventsConnector } from "../src/import-legacy-events";

let root: string;
let dbPath: string;
let jsonlPath: string;

function writeMapping(
  target: string,
  overrides: Record<string, unknown> = {},
): void {
  writeFileSync(
    `${target}.kizuki-mapping.json`,
    JSON.stringify({ ...LEGACY_EVENTS_FIXTURE.mapping, ...overrides }),
  );
}

function seedSqlite(): void {
  const db = new Database(dbPath);
  db.exec(LEGACY_EVENTS_FIXTURE.sql);
  db.close();
  writeMapping(dbPath);
}

function seedJsonl(): void {
  writeFileSync(jsonlPath, fixtureJsonl());
  writeMapping(jsonlPath, { table: null });
}

async function drain(connector: LegacyEventsConnector): Promise<number> {
  let cursor: string | null = null;
  let events = 0;
  for (let page = 0; page < 20; page += 1) {
    const batch = await connector.backfill(cursor);
    events += batch.events.length;
    cursor = batch.cursor;
    if (connector.lastReport()?.run.done === true) break;
  }
  return events;
}

type PageRow = { id: string; ts: number; body: string; extra: string };

function writePageRows(format: "jsonl" | "sqlite", rows: PageRow[]): string {
  const target = format === "jsonl" ? jsonlPath : dbPath;
  if (format === "jsonl") {
    writeFileSync(target, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
  } else {
    const db = new Database(target);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS events (id TEXT, ts INTEGER, body TEXT, extra TEXT)");
      db.exec("DELETE FROM events");
      const insert = db.query("INSERT INTO events VALUES (?, ?, ?, ?)");
      db.transaction(() => {
        for (const row of rows) insert.run(row.id, row.ts, row.body, row.extra);
      })();
    } finally {
      db.close();
    }
  }
  writeFileSync(`${target}.kizuki-mapping.json`, JSON.stringify({
    schema: "kizuki.legacy-events-mapping/v1",
    table: format === "sqlite" ? "events" : null,
    source_record_id: { column: "id" },
    kind: { const: "note" },
    occurred_at: { column: "ts", format: "unix_seconds" },
    text: { column: "body" },
    metadata: { columns: ["extra"] },
  }));
  return target;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kizuki-legacy-events-connector-"));
  dbPath = join(root, "legacy.db");
  jsonlPath = join(root, "legacy.jsonl");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the manifest", () => {
  test("kinds and capabilities are derived from the owner's mapping", () => {
    seedSqlite();
    expect(createLegacyEventsConnector({ path: dbPath }).manifest()).toEqual({
      schema: "kizuki.connector/v1",
      connector_id: LEGACY_EVENTS_CONNECTOR_ID,
      version: "0.1.0",
      contract_minor: 1,
      implementation: "@kizuki/connectors",
      allowed_egress: [],
      cursor_schema: "kizuki.legacy-events-cursor/v1",
      kinds: ["message", "note"],
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: true,
        purge: false,
        fixture: true,
      },
      required_secrets: [],
      emits_sensitivity_hint: true,
      default_sensitivity: "private",
      sensitivity_floor: "personal",
      auth_modes: ["none"],
    });
  });

  test("a mapping with no deletion rule does not claim tombstones", () => {
    seedSqlite();
    writeMapping(dbPath, { deleted: null, sensitivity_hint: null });
    const manifest = createLegacyEventsConnector({ path: dbPath }).manifest();
    expect(manifest.capabilities.tombstones).toBe(false);
    // A mapping that labels nothing still labels every row at the floor.
    expect(manifest.emits_sensitivity_hint).toBe(true);
  });

  test("the manifest grants no typed page", () => {
    seedSqlite();
    const manifest = createLegacyEventsConnector({ path: dbPath }).manifest();
    expect(manifest.capabilities.page_candidates).toBeUndefined();
  });

  test("a path with no known suffix needs an explicit format", () => {
    const odd = join(root, "export.bin");
    writeFileSync(odd, "");
    expect(() => createLegacyEventsConnector({ path: odd })).toThrow(
      /config.format is required/,
    );
  });
});

describe("paging and resume", () => {
  test("repeated backfill pages through the export exactly once", async () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE events (id TEXT, ts INTEGER, body TEXT)");
    const insert = db.query(
      "INSERT INTO events (id, ts, body) VALUES (?, ?, ?)",
    );
    db.transaction(() => {
      for (let i = 0; i < 2200; i += 1)
        insert.run(`r${i}`, 1_767_225_600 + i, "b");
    })();
    db.close();
    writeFileSync(
      `${dbPath}.kizuki-mapping.json`,
      JSON.stringify({
        schema: "kizuki.legacy-events-mapping/v1",
        table: "events",
        source_record_id: { column: "id" },
        kind: { const: "message" },
        occurred_at: { column: "ts", format: "unix_seconds" },
        text: { column: "body" },
      }),
    );

    const connector = createLegacyEventsConnector({ path: dbPath });
    expect(await drain(connector)).toBe(2200);
    expect(connector.lastReport()?.run.done).toBe(true);
  });

  test("a dense page stops before the serialized-byte envelope", async () => {
    const body = "x".repeat(5000);
    const lines = Array.from({ length: 1000 }, (_, index) =>
      JSON.stringify({
        id: `dense-${index}`,
        type: "note",
        ts: 1_767_225_600 + index,
        subject: `N${index}`,
        body,
      }),
    );
    writeFileSync(jsonlPath, `${lines.join("\n")}\n`);
    writeMapping(jsonlPath, { table: null });
    const connector = createLegacyEventsConnector({ path: jsonlPath });
    const first = await connector.backfill(null);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.length).toBeLessThan(1000);
    expect(
      Buffer.byteLength(JSON.stringify(first.events), "utf8"),
    ).toBeLessThanOrEqual(MAX_SYNC_BATCH_BYTES);
    expect(connector.lastReport()?.run.done).toBe(false);
    const db = openLedger(":memory:");
    expect(runBatch(db, first, { page_candidates: false }).stored).toBe(first.events.length);
    const second = await connector.backfill(first.cursor);
    expect(second.events.length).toBeGreaterThan(0);
    expect(
      second.events.map((event) => event.source_record_id),
    ).not.toEqual(first.events.map((event) => event.source_record_id));
    expect(runBatch(db, second, { page_candidates: false }).stored).toBe(second.events.length);
    db.close();
  });

  for (const format of ["jsonl", "sqlite"] as const) {
    test(`${format} drains multibyte text and metadata across a skipped boundary row`, async () => {
      const rows = Array.from({ length: 11 }, (_, index) => ({
        id: `unicode-${index}`, ts: 1_767_225_600 + index,
        body: "界".repeat(200_000), extra: "🧭".repeat(8000),
      }));
      // Six events fit, then this skip is consumed before the next full event.
      rows.splice(6, 0, { id: "", ts: 1_767_225_600, body: "skip", extra: "" });
      const target = writePageRows(format, rows);
      const ledger = openLedger(":memory:");
      try {
        let cursor: string | null = null;
        let done = false;
        const ids: string[] = [];
        for (let page = 0; page < 4 && !done; page += 1) {
          // Restart the connector between pages to exercise durable checkpoints.
          const connector = createLegacyEventsConnector({ path: target });
          const batch = await connector.backfill(cursor);
          expect(Buffer.byteLength(JSON.stringify(batch.events))).toBeLessThanOrEqual(MAX_SYNC_BATCH_BYTES);
          expect(runBatch(ledger, batch, { page_candidates: false }).stored).toBe(batch.events.length);
          ids.push(...batch.events.map(event => event.source_record_id));
          cursor = batch.cursor;
          done = connector.lastReport()?.run.done === true;
          if (page === 0) {
            expect(batch.events).toHaveLength(6);
            expect(connector.lastReport()?.counts).toMatchObject({ rows: 7, events: 6, skipped: 1 });
          }
          if (done) expect(connector.lastReport()?.counts).toMatchObject({ rows: 12, events: 11, skipped: 1 });
        }
        expect(done).toBe(true);
        expect(ids).toEqual(rows.filter(row => row.id !== "").map(row => row.id));
        expect(new Set(ids).size).toBe(11);
        const replay = await createLegacyEventsConnector({ path: target }).backfill(null);
        expect(runBatch(ledger, replay, { page_candidates: false }).stored).toBe(0);
      } finally {
        ledger.close();
      }
    });

    test(`${format} admits the exact byte limit and preserves the row one byte beyond it`, async () => {
      const rows = Array.from({ length: 18 }, (_, index) => ({
        id: `boundary-${index}`, ts: 1_767_225_600 + index,
        body: index < 17 ? "x".repeat(240_000) : "", extra: "",
      }));
      const target = writePageRows(format, rows);
      const probe = await createLegacyEventsConnector({ path: target }).backfill(null);
      expect(probe.events).toHaveLength(18);
      const remaining = MAX_SYNC_BATCH_BYTES - Buffer.byteLength(JSON.stringify(probe.events));
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThan(262_144);
      rows[17]!.body = "x".repeat(remaining);
      writePageRows(format, rows);
      const exact = await createLegacyEventsConnector({ path: target }).backfill(null);
      expect(exact.events).toHaveLength(18);
      expect(Buffer.byteLength(JSON.stringify(exact.events))).toBe(MAX_SYNC_BATCH_BYTES);

      rows[17]!.body += "x";
      writePageRows(format, rows);
      const connector = createLegacyEventsConnector({ path: target });
      const first = await connector.backfill(null);
      expect(first.events).toHaveLength(17);
      expect(connector.lastReport()?.run.done).toBe(false);
      const second = await createLegacyEventsConnector({ path: target }).sync(first.cursor);
      expect(second.events).toHaveLength(1);
      expect([...first.events, ...second.events].map(event => event.source_record_id)).toEqual(rows.map(row => row.id));
      const ledger = openLedger(":memory:");
      try {
        expect(runBatch(ledger, exact, { page_candidates: false }).stored).toBe(18);
      } finally {
        ledger.close();
      }
    });
  }

  test("a single oversized SQLite event fails closed without publishing a checkpoint", async () => {
    const db = new Database(dbPath);
    const columns = Array.from({ length: 260 }, (_, index) => `extra${index}`);
    try {
      db.exec(`CREATE TABLE events (id TEXT, ts INTEGER, body TEXT, ${columns.map(name => `${name} TEXT`).join(",")})`);
      db.query(`INSERT INTO events VALUES (${Array.from({ length: 263 }, () => "?").join(",")})`)
        .run("oversized", 1_767_225_600, "body", ...columns.map(() => "x".repeat(16_384)));
    } finally {
      db.close();
    }
    writeFileSync(`${dbPath}.kizuki-mapping.json`, JSON.stringify({
      schema: "kizuki.legacy-events-mapping/v1", table: "events",
      source_record_id: { column: "id" }, kind: { const: "note" },
      occurred_at: { column: "ts", format: "unix_seconds" }, text: { column: "body" },
      metadata: { columns: "rest" },
    }));
    const connector = createLegacyEventsConnector({ path: dbPath });
    await expect(connector.backfill(null)).rejects.toMatchObject({ code: "parse_error" });
    expect(connector.lastReport()).toBeNull();
  });

  test("backfill(null) twice yields the same first page", async () => {
    seedSqlite();
    const connector = createLegacyEventsConnector({ path: dbPath });
    const first = await connector.backfill(null);
    const second = await connector.backfill(null);
    const ledger = new InMemoryLedger();
    expect(
      ledger.acceptMany(first.events).every((r) => r.status === "stored"),
    ).toBe(true);
    expect(
      ledger.acceptMany(second.events).every((r) => r.status === "duplicate"),
    ).toBe(true);
  });

  test("sync after an appended row emits only that row", async () => {
    seedJsonl();
    const connector = createLegacyEventsConnector({ path: jsonlPath });
    const first = await connector.backfill(null);
    expect(first.events).toHaveLength(9);

    appendFileSync(
      jsonlPath,
      `${JSON.stringify({
        id: "r13",
        type: "note",
        ts: 1_767_226_320,
        subject: "Later",
        body: "Appended.",
      })}\n`,
    );
    const later = createLegacyEventsConnector({ path: jsonlPath });
    const second = await later.sync(first.cursor);
    expect(second.events.map((event) => event.source_record_id)).toEqual([
      "r13",
    ]);
  });

  test("a changed mapping and a shrunken source both restart from zero", async () => {
    seedJsonl();
    const first = await createLegacyEventsConnector({
      path: jsonlPath,
    }).backfill(null);

    writeMapping(jsonlPath, { table: null, sensitivity_hint: null });
    const remapped = createLegacyEventsConnector({ path: jsonlPath });
    await remapped.backfill(first.cursor);
    expect(remapped.lastReport()?.run).toMatchObject({
      from_position: "0",
      restarted: "mapping_changed",
    });

    writeMapping(jsonlPath, { table: null });
    writeFileSync(jsonlPath, '{"id":"r1","type":"note","ts":1767225600}\n');
    const shrunk = createLegacyEventsConnector({ path: jsonlPath });
    await shrunk.backfill(first.cursor);
    expect(shrunk.lastReport()?.run).toMatchObject({
      from_position: "0",
      restarted: "source_shrank",
    });
  });

  test("a malformed cursor is a parse error", async () => {
    seedSqlite();
    const connector = createLegacyEventsConnector({ path: dbPath });
    for (const cursor of [
      "{",
      '{"schema":"other"}',
      '{"schema":"kizuki.legacy-events-cursor/v1","mapping_hash":"a","position":-1,"done":false}',
      // A position that is not an exact decimal string: a number cannot carry
      // a rowid past 2^53, so the cursor grammar refuses one.
      '{"schema":"kizuki.legacy-events-cursor/v1","mapping_hash":"a","position":12,"done":false}',
      '{"schema":"kizuki.legacy-events-cursor/v1","mapping_hash":"a","position":"12.5","done":false}',
      // A run tally that is present but not a tally.
      '{"schema":"kizuki.legacy-events-cursor/v1","mapping_hash":"a","position":"12","done":false,"run":{"from_position":"0","counts":{"rows":"many"},"skipped":[]}}',
    ]) {
      let code = "";
      try {
        await connector.backfill(cursor);
      } catch (error) {
        if (!(error instanceof KizukiError)) throw error;
        code = error.code;
      }
      expect(code).toBe("parse_error");
    }
  });

  test("a mapping naming absent columns refuses before a row is read", async () => {
    seedSqlite();
    writeMapping(dbPath, { text: { column: "absent_column" } });
    const connector = createLegacyEventsConnector({ path: dbPath });
    let message = "";
    try {
      await connector.backfill(null);
    } catch (error) {
      if (!(error instanceof KizukiError)) throw error;
      message = error.message;
    }
    expect(message).toContain(
      "mapping names columns the source does not have: absent_column",
    );
  });
});

describe("the run through a real ledger", () => {
  test("a deleted row withdraws the pending proposal it created", async () => {
    seedJsonl();
    const vault = join(root, "vault");
    initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    try {
      const connector = createLegacyEventsConnector({ path: jsonlPath });
      const source = "01JJ0000000000000000000004";
      registerConnection(db, LEGACY_EVENTS_CONNECTOR_ID, source);
      // Explicit synthetic owner consent; keep connector sensitivity authoritative.
      setSourceGrant(db, {
        source_key: source, expected_revision: 0, operation_id: "fixture-grant",
        policy: {
          purposes: ["capture", "recall", "derive"],
          allowed_fields: ["text", "subjects", "attachments", "metadata"],
          retention: "persistent_owned_until_revoked", egress: "local_only",
          sensitivity_floor: "public",
        },
      });
      const first = await runSync(
        db,
        connector,
        LEGACY_EVENTS_CONNECTOR_ID,
        source,
      );
      expect(first.stored).toBe(9);
      expect(first.proposals_created).toBeGreaterThan(0);
      const cited = listClaims(db, { status: "live" }).filter((claim) =>
        claim.body.includes("It is on."),
      );
      expect(cited.length).toBeGreaterThan(0);

      appendFileSync(
        jsonlPath,
        `${JSON.stringify({
          id: "r1",
          type: "msg",
          ts: 1_767_225_600,
          subject: "The kettle",
          body: "It is on.",
          sender: "Ada",
          recipients: "Grace",
          is_deleted: 1,
        })}\n`,
      );
      const second = await runSync(
        db,
        createLegacyEventsConnector({ path: jsonlPath }),
        LEGACY_EVENTS_CONNECTOR_ID,
        source,
      );
      expect(second.stored).toBe(1);
      expect(second.withdrawn).toBeGreaterThan(0);
      expect(
        listClaims(db, { status: "live" }).filter((claim) =>
          claim.body.includes("It is on."),
        ),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("a row the ledger would refuse", () => {
  test("is skipped by position so the cursor still advances", async () => {
    // Date renders this epoch as a six-digit year; the ledger refuses the
    // string. Emitting it would fail the batch and hold the cursor at null,
    // making every later row unreachable however often the owner re-runs.
    writeFileSync(
      jsonlPath,
      [
        { id: "r1", type: "note", ts: 1_767_225_600, body: "first" },
        { id: "r2", type: "note", ts: 8_640_000_000_000, body: "unusable" },
        { id: "r3", type: "note", ts: 1_767_225_601, body: "last" },
      ]
        .map((row) => `${JSON.stringify(row)}\n`)
        .join(""),
    );
    writeMapping(jsonlPath, {
      table: null,
      kind: { column: "type", values: { note: "note" }, default: null },
      subjects: [],
      sensitivity_hint: null,
      deleted: null,
      text: { column: "body" },
    });

    const vault = join(root, "vault");
    initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    try {
      const connector = createLegacyEventsConnector({ path: jsonlPath });
      const source = "01JJ0000000000000000000004";
      registerConnection(db, LEGACY_EVENTS_CONNECTOR_ID, source);
      // Explicit synthetic owner consent; keep connector sensitivity authoritative.
      setSourceGrant(db, {
        source_key: source, expected_revision: 0, operation_id: "fixture-grant",
        policy: {
          purposes: ["capture", "recall", "derive"],
          allowed_fields: ["text", "subjects", "attachments", "metadata"],
          retention: "persistent_owned_until_revoked", egress: "local_only",
          sensitivity_floor: "public",
        },
      });
      const run = await runBackfill(
        db,
        connector,
        LEGACY_EVENTS_CONNECTOR_ID,
        source,
      );
      expect(run.errors).toEqual([]);
      expect(run.stored).toBe(2);
      expect(connector.lastReport()?.skipped).toEqual([
        { position: "120", reason: "occurred_at_invalid" },
      ]);
      expect(
        getCheckpoint(db, LEGACY_EVENTS_CONNECTOR_ID, source)?.cursor,
      ).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("the report file", () => {
  test("counts the run and lists skips by position only", async () => {
    seedSqlite();
    const reportPath = join(root, "events-report.md");
    const connector = createLegacyEventsConnector({
      path: dbPath,
      report: reportPath,
    });
    await connector.backfill(null);
    const report = connector.lastReport();
    expect(report?.counts).toMatchObject({
      rows: 12,
      events: 9,
      tombstones: 1,
      skipped: 3,
      blobs_dropped: 1,
    });
    expect(report?.skipped.map((skip) => skip.reason).sort()).toEqual([
      "kind_unmapped",
      "occurred_at_invalid",
      "source_record_id_missing",
    ]);

    const markdown = readFileSync(reportPath, "utf8");
    expect(statSync(reportPath).mode & 0o777).toBe(0o600);
    for (const secret of ["kettle", "library", "Tea.", "Appended"]) {
      expect(markdown).not.toContain(secret);
    }
    expect(JSON.stringify(report)).not.toContain("kettle");
  });

  test("an exhausted page keeps the record of what the run dropped", async () => {
    seedSqlite();
    const reportPath = join(root, "events-report.json");
    const first = createLegacyEventsConnector({
      path: dbPath,
      report: reportPath,
    });
    const batch = await first.backfill(null);

    // The documented recipe is to sync until nothing is stored. That last
    // call reads no rows, and it must not overwrite the migration record
    // with an all-zero one.
    const second = createLegacyEventsConnector({
      path: dbPath,
      report: reportPath,
    });
    const exhausted = await second.sync(batch.cursor);
    expect(exhausted.events).toEqual([]);

    const report = second.lastReport();
    expect(report?.counts).toMatchObject({ rows: 12, events: 9, skipped: 3 });
    expect(report?.skipped).toHaveLength(3);
    expect((await second.health()).state).toBe("degraded");
    const onDisk = JSON.parse(readFileSync(reportPath, "utf8")) as {
      counts: { rows: number; skipped: number };
      skipped: unknown[];
      run: { from_position: string; done: boolean };
    };
    expect(onDisk.counts).toMatchObject({ rows: 12, skipped: 3 });
    expect(onDisk.skipped).toHaveLength(3);
    expect(onDisk.run).toMatchObject({ from_position: "0", done: true });
  });

  test("a run that pages twice reports both pages, not the last one", async () => {
    const path = join(root, "paged.db");
    const db = new Database(path);
    db.exec("CREATE TABLE events (id TEXT, ts INTEGER, body TEXT)");
    const insert = db.query(
      "INSERT INTO events (id, ts, body) VALUES (?, ?, ?)",
    );
    db.transaction(() => {
      for (let i = 0; i < 1400; i += 1) {
        // Every tenth row carries an unreadable timestamp, so both pages drop
        // rows the report has to keep naming.
        insert.run(`r${i}`, i % 10 === 0 ? null : 1_767_225_600 + i, "b");
      }
    })();
    db.close();
    writeFileSync(
      `${path}.kizuki-mapping.json`,
      JSON.stringify({
        schema: "kizuki.legacy-events-mapping/v1",
        table: "events",
        source_record_id: { column: "id" },
        kind: { const: "message" },
        occurred_at: { column: "ts", format: "unix_seconds" },
        text: { column: "body" },
      }),
    );

    const reportPath = join(root, "paged-report.json");
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const connector = createLegacyEventsConnector({ path, report: reportPath });
      const batch = await connector.backfill(cursor);
      cursor = batch.cursor;
      pages += 1;
      const decoded = JSON.parse(cursor as string) as { done: boolean };
      if (decoded.done) break;
      if (pages > 4) throw new Error("paging did not finish");
    }
    expect(pages).toBe(2);
    const onDisk = JSON.parse(readFileSync(reportPath, "utf8")) as {
      counts: { rows: number; events: number; skipped: number };
      skipped: unknown[];
    };
    expect(onDisk.counts).toMatchObject({ rows: 1400, events: 1260, skipped: 140 });
    expect(onDisk.skipped).toHaveLength(140);
  });

  test("health degrades after a run that skipped rows", async () => {
    seedSqlite();
    const connector = createLegacyEventsConnector({ path: dbPath });
    expect((await connector.health()).state).toBe("ok");
    await connector.backfill(null);
    const health = await connector.health();
    expect(health.state).toBe("degraded");
    expect(health.detail).toBe("3 row(s) skipped; see the report");
  });

  test("a refusal never quotes a row's text", async () => {
    seedSqlite();
    writeMapping(dbPath, { text: { column: "absent_column" } });
    const connector = createLegacyEventsConnector({ path: dbPath });
    try {
      await connector.backfill(null);
    } catch (error) {
      expect((error as Error).message).not.toContain("kettle");
      expect((error as Error).message).not.toContain("library");
    }
  });
});
