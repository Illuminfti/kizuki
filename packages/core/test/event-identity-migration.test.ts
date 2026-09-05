import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/ledger/db";
import { accept, count, readSince } from "../src/ledger/ledger";
import { computeLegacyContentHash, sha256Hex } from "../src/util/hash";
import { validEvent } from "./fixtures";

function legacyFixture(size = 1) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-event-v15-"));
  const path = join(root, "ledger.sqlite");
  const db = openLedger(path);
  for (let i = 0; i < size; i++) {
    const input = { ...validEvent(), source_record_id: `legacy-${i}` };
    const stored = accept(db, input);
    if (stored.status !== "stored") throw new Error("fixture event failed");
    db.query("UPDATE events SET content_hash=? WHERE event_id=?").run(computeLegacyContentHash(input), stored.event.event_id);
  }
  db.exec(`
    DROP TRIGGER events_identity_insert; DROP TRIGGER events_identity_update;
    DROP TRIGGER canon_loop_hash_insert; DROP TRIGGER canon_loop_hash_update;
    DROP TRIGGER native_owner_hash_insert; DROP TRIGGER native_owner_hash_update;
    ALTER TABLE native_owner_evidence DROP COLUMN event_content_hash;
    DROP INDEX canon_loop_before_hash; DROP INDEX canon_loop_after_hash;
    DROP TABLE canon_machine_byte_intents;
    ALTER TABLE events DROP COLUMN content_hash_version;
    ALTER TABLE events DROP COLUMN text_hash;
    ALTER TABLE events DROP COLUMN origin;
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
        expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: 16 });
        const rows = db.query<Record<string, unknown>, []>("SELECT * FROM events ORDER BY event_id").all();
        expect(rows.map(({ content_hash_version, text_hash, origin, ...row }) => row)).toEqual(old);
        expect(rows.every(row => row["content_hash_version"] === 1 && row["origin"] === "external" && row["text_hash"] === sha256Hex(validEvent().text))).toBe(true);
        expect(accept(db, { ...validEvent(), source_record_id: "legacy-0", observed_at: "2030-01-01T00:00:00Z" }).status).toBe("duplicate");
        expect(count(db)).toBe(65);
        expect(accept(db, { ...validEvent(), source_record_id: "legacy-0", sensitivity_hint: "private" }).status).toBe("stored");
        expect(accept(db, { ...validEvent(), source_record_id: "legacy-0", attachments: [] }).status).toBe("stored");
        expect(count(db)).toBe(67);
        expect(readSince(db, null, 100).events.filter(event => event.content_hash_version === 2)).toHaveLength(2);
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
      text: "KIZUKI CONTEXT v1 deliberate legacy native correction" };
    const contentHash = computeLegacyContentHash(input);
    f.db.query("UPDATE events SET connector_id=?,text=?,content_hash=?").run(input.connector_id, input.text, contentHash);
    const event = f.db.query<{ event_id: string }, []>("SELECT event_id FROM events").get()!;
    f.db.query("INSERT INTO native_owner_evidence VALUES (?,'correction',?,?,'recorded')")
      .run(event.event_id, sha256Hex("legacy-native-request"), input.observed_at);
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
