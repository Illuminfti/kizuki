import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_SCHEMA_VERSION, inspectOpenLedgerHealth, openLedger } from "../src/ledger/db";
import { accept, count, readSince } from "../src/ledger/ledger";
import { computeLegacyContentHash, sha256Hex } from "../src/util/hash";
import { validEvent } from "./fixtures";
import { readDurableExtractBatch, validateDurableExtractStorage, LegacyExtractReconciliationError } from "../src/serve/extract";
import { runWritePass } from "../src/serve/write-pass";
import { createBudgetTracker } from "../src/canon/budget";
import { initVault } from "../src/vault/init";
import type { ProducerPort } from "../src/contracts/producer";

function legacyFixture(size = 1) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-event-v15-"));
  const path = join(root, "ledger.sqlite");
  const db = openLedger(path);
  db.exec("DROP TRIGGER events_identity_update");
  for (let i = 0; i < size; i++) {
    const input = { ...validEvent(), source_record_id: `legacy-${i}` };
    const stored = accept(db, input);
    if (stored.status !== "stored") throw new Error("fixture event failed");
    db.query("UPDATE events SET content_hash=? WHERE event_id=?").run(computeLegacyContentHash(input), stored.event.event_id);
  }
  db.exec(`
    DROP TABLE purge_batch_receipts;
    DROP TABLE purge_batches;
    DROP TRIGGER agent_enrollments_block_legacy_agent_insert;
    DROP TRIGGER agent_enrollments_block_token_update;
    DROP TABLE agent_enrollments;
    DROP TRIGGER events_identity_insert;
    DROP TRIGGER canon_loop_hash_insert; DROP TRIGGER canon_loop_hash_update;
    DROP TRIGGER native_owner_hash_insert; DROP TRIGGER native_owner_hash_update;
    ALTER TABLE native_owner_evidence DROP COLUMN event_content_hash;
    DROP INDEX canon_loop_before_hash; DROP INDEX canon_loop_after_hash;
    DROP TABLE canon_machine_byte_intents;
    ALTER TABLE events DROP COLUMN content_hash_version;
    ALTER TABLE events DROP COLUMN text_hash;
    ALTER TABLE events DROP COLUMN origin;
    ALTER TABLE events DROP COLUMN origin_binding_version;
    ALTER TABLE events DROP COLUMN origin_binding_kind;
    ALTER TABLE events DROP COLUMN origin_binding;
    CREATE TABLE events_v15 (
      event_id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      source_record_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      text TEXT NOT NULL,
      subjects TEXT NOT NULL,
      sensitivity_hint TEXT,
      deleted INTEGER NOT NULL,
      attachments TEXT NOT NULL,
      metadata TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      UNIQUE(connector_id, source_record_id, content_hash)
    );
    INSERT INTO events_v15
      SELECT event_id, connector_id, source_record_id, kind,
             occurred_at, observed_at, text, subjects, sensitivity_hint,
             deleted, attachments, metadata, content_hash, accepted_at
        FROM events;
    DROP TABLE events;
    ALTER TABLE events_v15 RENAME TO events;
    CREATE INDEX events_accepted_order_idx ON events(accepted_at, event_id);
    CREATE INDEX events_connector_idx ON events(connector_id);
    CREATE INDEX events_kind_idx ON events(kind);
    CREATE TABLE checkpoints_v15 (
      connector_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      cursor TEXT,
      mode TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_run_at TEXT NOT NULL,
      last_result TEXT NOT NULL,
      PRIMARY KEY (connector_id, source_key)
    );
    INSERT INTO checkpoints_v15
      SELECT connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result
        FROM checkpoints;
    DROP TABLE checkpoints;
    ALTER TABLE checkpoints_v15 RENAME TO checkpoints;
    DROP TABLE IF EXISTS rail_cursors;
    UPDATE schema_version SET version=15;
  `);
  return { root, path, db };
}

describe("event identity migration", () => {
  test("backfills multiple keyset pages without rewriting old event bytes or hashes", () => {
    const f = legacyFixture(65);
    const old = f.db.query<Record<string, unknown>, []>("SELECT * FROM events ORDER BY event_id").all();
    f.db.close();
    try {
      const db = openLedger(f.path);
      try {
        expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: LEDGER_SCHEMA_VERSION });
        const rows = db.query<Record<string, unknown>, []>("SELECT * FROM events ORDER BY event_id").all();
        expect(rows.map(({ content_hash_version, text_hash, origin, origin_binding_version, origin_binding_kind, origin_binding, ...row }) => row)).toEqual(old);
        expect(rows.every(row => row["content_hash_version"] === 1 && row["origin"] === "external" && row["text_hash"] === sha256Hex(validEvent().text))).toBe(true);
        expect(inspectOpenLedgerHealth(db, { full: true })).toMatchObject({ ok: true, sampled_events: 65, failures: [] });
        expect(accept(db, { ...validEvent(), source_record_id: "legacy-0", observed_at: "2030-01-01T00:00:00Z" }).status).toBe("duplicate");
        expect(count(db)).toBe(65);
        expect(accept(db, { ...validEvent(), source_record_id: "legacy-0", sensitivity_hint: "private" }).status).toBe("stored");
        expect(accept(db, { ...validEvent(), source_record_id: "legacy-0", attachments: [] }).status).toBe("stored");
        expect(count(db)).toBe(67);
        expect(readSince(db, null, 100).events.filter(event => event.content_hash_version === 2)).toHaveLength(2);
        expect(inspectOpenLedgerHealth(db)).toMatchObject({ ok: true, sampled_events: 67, failures: [] });
      } finally { db.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("hash corruption aborts the entire migration with the legacy schema intact", () => {
    const f = legacyFixture(40);
    f.db.query("UPDATE events SET text='corrupt synthetic text' WHERE source_record_id='legacy-39'").run();
    const old = f.db.query("SELECT * FROM events ORDER BY event_id").all();
    f.db.close();
    try {
      expect(() => openLedger(f.path)).toThrow("event record is invalid");
      const db = new Database(f.path);
      try {
        expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: 15 });
        expect(db.query("SELECT * FROM events ORDER BY event_id").all()).toEqual(old);
        expect(db.query("SELECT name FROM sqlite_master WHERE name='canon_machine_byte_intents'").get()).toBeNull();
        expect(db.query<{ name: string }, []>("PRAGMA table_info(events)").all().map(row => row.name)).not.toContain("origin");
      } finally { db.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("current schema refuses old inserts that omit spine fields", () => {
    const db = openLedger(":memory:");
    try {
      const result = accept(db, validEvent());
      if (result.status !== "stored") throw new Error("fixture failed");
      expect(() => db.exec(`INSERT INTO events(event_id,connector_id,source_record_id,kind,occurred_at,observed_at,text,subjects,deleted,attachments,metadata,content_hash,accepted_at)
        SELECT '01ARZ3NDEKTSV4RRFFQ69G5FAV',connector_id,'old-insert',kind,occurred_at,observed_at,text,subjects,deleted,attachments,metadata,content_hash,accepted_at FROM events LIMIT 1`))
        .toThrow("event identity fields are required");
      expect(count(db)).toBe(1);
    } finally { db.close(); }
  });

  test.each(["sensitivity_hint", "deleted"])("an oversized legacy %s fails preflight with no migration effects", (column) => {
    const f = legacyFixture();
    f.db.query(`UPDATE events SET ${column}=?`).run("x".repeat(1_000_000));
    f.db.close();
    try {
      expect(() => openLedger(f.path)).toThrow("event record is invalid");
      const db = new Database(f.path);
      try {
        expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: 15 });
        expect(db.query(`SELECT length(${column}) AS bytes FROM events`).get()).toEqual({ bytes: 1_000_000 });
        expect(db.query("SELECT name FROM sqlite_master WHERE name='canon_machine_byte_intents'").get()).toBeNull();
        expect(db.query<{ name: string }, []>("PRAGMA table_info(events)").all().map(row => row.name)).not.toContain("origin");
      } finally { db.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("binds a valid legacy native proof to the unchanged v1 event hash", () => {
    const f = legacyFixture();
    const input = { ...validEvent(), connector_id: "kizuki.owner", source_record_id: "legacy-0",
      text: "Deliberate legacy native correction matching old machine bytes" };
    const contentHash = computeLegacyContentHash(input);
    f.db.query("UPDATE events SET connector_id=?,text=?,content_hash=?").run(input.connector_id, input.text, contentHash);
    const event = f.db.query<{ event_id: string }, []>("SELECT event_id FROM events").get()!;
    f.db.query("INSERT INTO native_owner_evidence VALUES (?,'correction',?,?,'recorded')")
      .run(event.event_id, sha256Hex("legacy-native-request"), input.observed_at);
    receiptMatch(f.db, input.text, [event.event_id]);
    const boundary = position(f.db);
    frontier(f.db, `${boundary.accepted_at}\t${boundary.event_id}`);
    f.db.close();
    try {
      const db = openLedger(f.path);
      try {
        expect(readSince(db, null, 1).events[0]).toMatchObject({
          event_id: event.event_id, content_hash: contentHash, content_hash_version: 1, origin: "external",
        });
        expect(db.query("SELECT event_content_hash FROM native_owner_evidence").get())
          .toEqual({ event_content_hash: contentHash });
      } finally { db.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("refuses a legacy native proof attached to ordinary captured evidence", () => {
    const f = legacyFixture();
    const event = f.db.query<{ event_id: string }, []>("SELECT event_id FROM events").get()!;
    f.db.query("INSERT INTO native_owner_evidence VALUES (?,'correction',?,?,'recorded')")
      .run(event.event_id, sha256Hex("invalid-native-request"), validEvent().observed_at);
    f.db.close();
    try {
      expect(() => openLedger(f.path)).toThrow("event record is invalid");
      const db = new Database(f.path);
      try {
        expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: 15 });
        expect(db.query<{ name: string }, []>("PRAGMA table_info(native_owner_evidence)").all().map(row => row.name))
          .not.toContain("event_content_hash");
      } finally { db.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

function receiptMatch(db: Database, text: string, provenance: string[] = []): void {
  db.query(`INSERT INTO canon_receipts(receipt_id,provenance,sensitivity,page_path,after_hash,at,writer)
    VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV',?,'personal','people/legacy.md',?,'2026-01-01T00:00:00Z','loop')`)
    .run(JSON.stringify(provenance), sha256Hex(text));
}
function frontier(db: Database, cursor: string, key = "extract"): void {
  db.query(`INSERT INTO checkpoints(connector_id,source_key,cursor,mode,updated_at,last_run_at,last_result)
    VALUES ('kizuki.producer.model',?,?,'incremental','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','ok')`).run(key, cursor);
}
function position(db: Database): { event_id: string; accepted_at: string } {
  return db.query<{ event_id: string; accepted_at: string }, []>("SELECT event_id,accepted_at FROM events").get()!;
}

test("v17 event rebuild keeps pending deferred extract rows", () => {
  const f = legacyFixture();
  const row = position(f.db);
  f.db.query("INSERT INTO extract_deferred_inputs VALUES (?, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 1, ?)")
    .run(row.event_id, "a".repeat(64));
  const deferred = f.db.query("SELECT * FROM extract_deferred_inputs").all();
  f.db.close();
  try {
    const db = openLedger(f.path);
    try {
      expect(db.query("SELECT version FROM schema_version").get()).toEqual({
        version: LEDGER_SCHEMA_VERSION,
      });
      expect(db.query("SELECT * FROM extract_deferred_inputs").all()).toEqual(deferred);
    } finally {
      db.close();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("legacy receipt match without derived effects receives one stable legacy binding", () => {
  const f = legacyFixture();
  receiptMatch(f.db, validEvent().text);
  f.db.close();
  try {
    const migrated = openLedger(f.path);
    const event = readSince(migrated, null, 1).events[0]!;
    expect(event).toMatchObject({ origin: "self", origin_binding_version: 1, origin_binding_kind: "legacy" });
    migrated.close();
    const reopened = openLedger(f.path);
    try { expect(readSince(reopened, null, 1).events[0]).toEqual(event); }
    finally { reopened.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test.each(["completed frontier", "direct receipt evidence", "ambiguous deferred completion", "rebound deferred input"])(
  "legacy machine evidence refuses %s with the old ledger intact", (state) => {
    const f = legacyFixture();
    const row = position(f.db);
    receiptMatch(f.db, validEvent().text, state === "direct receipt evidence" ? [row.event_id] : []);
    if (state === "completed frontier") frontier(f.db, `${row.accepted_at}\t${row.event_id}`);
    if (state === "ambiguous deferred completion") frontier(f.db, row.event_id, "extract-deferred-scan");
    if (state === "rebound deferred input") {
      f.db.query("INSERT INTO extract_deferred_inputs VALUES (?, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 1, ?)").run(row.event_id, "a".repeat(64));
    }
    const original = f.db.query("SELECT * FROM events").get();
    f.db.close();
    try {
      expect(() => openLedger(f.path)).toThrow("legacy_origin_rebuild_required");
      const old = new Database(f.path);
      try {
        expect(old.query("SELECT version FROM schema_version").get()).toEqual({ version: 15 });
        expect(old.query("SELECT * FROM events").get()).toEqual(original);
        expect(old.query("SELECT 1 FROM sqlite_master WHERE name='canon_machine_byte_intents'").get()).toBeNull();
      } finally { old.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  },
);

test("a legacy machine match strictly after completed frontier and deferred scan remains admissible", () => {
  const f = legacyFixture();
  const row = position(f.db);
  receiptMatch(f.db, validEvent().text);
  frontier(f.db, "2020-01-01T00:00:00Z\t01ARZ3NDEKTSV4RRFFQ69G5FAV");
  frontier(f.db, row.event_id, "extract-deferred-scan");
  f.db.close();
  try {
    const db = openLedger(f.path);
    try { expect(readSince(db, null, 1).events[0]).toMatchObject({ origin: "self", origin_binding_kind: "legacy" }); }
    finally { db.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("historically excluded context markers remain safe behind a completed frontier", () => {
  const f = legacyFixture();
  const input = { ...validEvent(), source_record_id: "legacy-0", text: "KIZUKI CONTEXT v1 historical machine context" };
  f.db.query("UPDATE events SET text=?,content_hash=?").run(input.text, computeLegacyContentHash(input));
  const row = position(f.db);
  receiptMatch(f.db, input.text, [row.event_id]);
  frontier(f.db, `${row.accepted_at}\t${row.event_id}`);
  f.db.close();
  try {
    const db = openLedger(f.path);
    try { expect(readSince(db, null, 1).events[0]).toMatchObject({ origin: "self", origin_binding_kind: "legacy" }); }
    finally { db.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

function pendingLegacyDecision(db: Database, eventId: string, at: string): void {
  const drafts = [{ kind: "claim", subject: "person:legacy", predicate: "employment.works_at", object: "Acme",
    polarity: "positive", body: "Legacy works at Acme.", valid_from: null, valid_to: null,
    confidence: 0.8, sensitivity: "personal", event_ids: [eventId] }];
  db.query(`INSERT INTO extract_batches(previous_cursor,cursor,drafts,model_ref,created_at)
    VALUES ('',?,?,'kizuki.llm.synthetic:legacy-origin',?)`)
    .run(`${at}\t${eventId}`, JSON.stringify(drafts), at);
}

test("a legacy pending decision remains storage-only after origin migration", async () => {
  const f = legacyFixture();
  const row = position(f.db);
  receiptMatch(f.db, validEvent().text);
  pendingLegacyDecision(f.db, row.event_id, row.accepted_at);
  const original = f.db.query("SELECT drafts FROM extract_batches").get();
  f.db.close();
  try {
    const vault = join(f.root, "vault");
    initVault(vault);
    const db = openLedger(f.path);
    try {
      const rows = () => ["events", "claims", "claim_supersessions", "extract_batches",
        "extract_deferred_inputs", "checkpoints", "retrieval_ops", "canon_receipts", "canon_machine_byte_intents"]
        .map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const before = rows();
      expect(readSince(db, null, 1).events[0]).toMatchObject({ origin: "self", origin_binding_kind: "legacy" });
      expect(() => validateDurableExtractStorage(db)).not.toThrow();
      expect(() => readDurableExtractBatch(db)).toThrow(LegacyExtractReconciliationError);
      expect(db.query("SELECT drafts FROM extract_batches").get()).toEqual(original);
      let calls = 0;
      const producer: ProducerPort = {
        descriptor: { id: "kizuki.producer.legacy-origin", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1,
          supports: ["model"], requires_lease: false, optional_package: null },
        health: async () => ({ status: "ready", detail: {} }), close: async () => undefined,
        produce: async () => { calls += 1; throw new Error("legacy replay must not call a model"); },
      };
      await expect(runWritePass(db, vault, {
        budget: createBudgetTracker({ canon_writes_per_run: 4 }), claims: { db }, producer,
      })).rejects.toThrow(LegacyExtractReconciliationError);
      expect(calls).toBe(0);
      expect(rows()).toEqual(before);
      expect(db.query("SELECT drafts FROM extract_batches").get()).toEqual(original);
      expect(db.query("SELECT 1 FROM claims").get()).toBeNull();
      expect(db.query("SELECT 1 FROM checkpoints WHERE source_key='extract'").get()).toBeNull();
    } finally { db.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test.each(["direct provenance", "discarded partial corroboration", "nested provenance"])("legacy claims refuse %s", (state) => {
  const f = legacyFixture();
  const row = position(f.db);
  receiptMatch(f.db, validEvent().text);
  if (state === "discarded partial corroboration") pendingLegacyDecision(f.db, row.event_id, row.accepted_at);
  f.db.query(`INSERT INTO claims(claim_id,kind,body,frontmatter,provenance,subjects,producer,confidence,status,created_at,body_hash)
    VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV','claim','Synthetic historical claim','{}',?,'[]','model',0.8,'live',?,?)`)
    .run(JSON.stringify(state === "direct provenance" ? [row.event_id] : state === "nested provenance" ? [[row.event_id]] : []), row.accepted_at, sha256Hex("Synthetic historical claim"));
  f.db.close();
  try { expect(() => openLedger(f.path)).toThrow("legacy_origin_rebuild_required"); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});
