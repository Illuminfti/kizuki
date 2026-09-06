import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { accept } from "../src/ledger/ledger";
import { bindLegacyEventOrigins } from "../src/ledger/event-identity-schema";
import { computeLegacyContentHash, sha256Hex } from "../src/util/hash";
import { ulid } from "../src/util/ulid";
import { validEvent } from "./fixtures";

function fixture(events: number, effects: number) {
  const db = openLedger(":memory:");
  db.exec("DROP TRIGGER events_identity_update");
  db.transaction(() => {
    const witnessInput = { ...validEvent(), source_record_id: "historical-witness", text: "Independent external evidence" };
    const witness = accept(db, witnessInput);
    if (witness.status !== "stored") throw new Error("fixture witness failed");
    db.query("UPDATE events SET content_hash=? WHERE event_id=?")
      .run(computeLegacyContentHash(witnessInput), witness.event.event_id);
    for (let index = 0; index < events; index++) {
      const input = { ...validEvent(), source_record_id: `legacy-${index}` };
      const admitted = accept(db, input);
      if (admitted.status !== "stored") throw new Error("fixture admission failed");
      db.query("UPDATE events SET content_hash=? WHERE event_id=?")
        .run(computeLegacyContentHash(input), admitted.event.event_id);
    }
    const claim = db.query(`INSERT INTO claims(claim_id,kind,body,frontmatter,provenance,subjects,producer,confidence,status,created_at,body_hash)
      VALUES (?,'claim',?,'{}',?,'[]','model',0.8,'live','2026-01-01T00:00:00Z',?)`);
    const receipt = db.query(`INSERT INTO canon_receipts(receipt_id,provenance,sensitivity,page_path,after_hash,at,writer)
      VALUES (?,?,'personal','people/legacy.md',?,'2026-01-01T00:00:00Z','loop')`);
    for (let index = 0; index < effects; index++) {
      claim.run(ulid(), `Synthetic historical claim ${index}`, JSON.stringify([witness.event.event_id]), sha256Hex(`Synthetic historical claim ${index}`));
      receipt.run(ulid(), JSON.stringify([witness.event.event_id]), sha256Hex(validEvent().text));
    }
  }).immediate();
  return db;
}

function measure(events: number, effects: number) {
  const db = fixture(events, effects);
  let globalScans = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string, ...args: Parameters<typeof prepare> extends [string, ...infer R] ? R : never) => {
    if (/\b(?:FROM|JOIN)\s+(?:claims|canon_receipts)\b/i.test(sql) && /\bprovenance\b/i.test(sql)) globalScans++;
    return prepare(sql, ...args);
  }) as typeof db.prepare;
  try {
    const start = performance.now();
    db.transaction(() => bindLegacyEventOrigins(db)).immediate();
    const elapsed = performance.now() - start;
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE origin='self' AND origin_binding_kind='legacy'").get()?.n).toBe(events);
    expect(db.query("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'kizuki_legacy_origin%'").get()).toBeNull();
    return { globalScans, elapsed };
  } finally { db.close(); }
}

describe("bounded legacy-origin contamination preflight", () => {
  test("refuses aggregate provenance overflow before parsing any history JSON", () => {
    const db = fixture(2, 1_033);
    const provenance = JSON.stringify(["x".repeat(65_000)]);
    let historyJsonQueries = 0;
    try {
      db.query("UPDATE claims SET provenance=?").run(provenance);
      const original = db.query("SELECT * FROM events ORDER BY event_id").all();
      // Observe the SQLite boundary: an over-budget table must be refused
      // from metadata before submitting any history query to a JSON walker.
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string, ...args: Parameters<typeof prepare> extends [string, ...infer R] ? R : never) => {
        if (/\b(?:FROM|JOIN)\s+claims\b/i.test(sql) && /json_\w+\(\s*(?:\w+\.)?provenance\b/i.test(sql)) historyJsonQueries++;
        return prepare(sql, ...args);
      }) as typeof db.prepare;
      expect(() => db.transaction(() => bindLegacyEventOrigins(db)).immediate()).toThrow("legacy_origin_rebuild_required");
      expect(historyJsonQueries).toBe(0);
      expect(db.query("SELECT * FROM events ORDER BY event_id").all()).toEqual(original);
      expect(db.query("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'kizuki_legacy_origin%'").get()).toBeNull();
    } finally { db.close(); }
  });

  test("migration scans global evidence a constant number of times as candidate count grows", () => {
    const small = measure(100, 100);
    const large = measure(200, 200);
    // Count actual prepared global scans, avoiding a machine-speed timing gate.
    expect(small.globalScans).toBeLessThanOrEqual(12);
    expect(large.globalScans).toBe(small.globalScans);
  });

  test.each(["oversized checkpoint", "non-array pending drafts"])("refuses %s before committing legacy bindings", (kind) => {
    const db = fixture(2, 1);
    try {
      const original = db.query("SELECT * FROM events ORDER BY event_id").all();
      if (kind === "oversized checkpoint") {
        db.query(`INSERT INTO rail_cursors(rail,source_key,cursor,updated_at)
          VALUES ('kizuki.producer.model','extract',?,'2026-01-01T00:00:00Z')`).run("x".repeat(257));
      } else {
        db.query(`INSERT INTO extract_batches(previous_cursor,cursor,drafts,model_ref,created_at)
          VALUES ('','','{}',NULL,'2026-01-01T00:00:00Z')`).run();
      }
      expect(() => db.transaction(() => bindLegacyEventOrigins(db)).immediate()).toThrow("legacy_origin_rebuild_required");
      expect(db.query("SELECT * FROM events ORDER BY event_id").all()).toEqual(original);
      expect(db.query("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'kizuki_legacy_origin%'").get()).toBeNull();
    } finally { db.close(); }
  });

  test("a referenced candidate rolls back every binding and removes temporary state", () => {
    const db = fixture(65, 1);
    try {
      const original = db.query("SELECT * FROM events ORDER BY event_id").all();
      const last = db.query<{ event_id: string }, []>("SELECT event_id FROM events ORDER BY event_id DESC LIMIT 1").get()!;
      db.query("UPDATE claims SET provenance=?").run(JSON.stringify([last.event_id]));
      expect(() => db.transaction(() => bindLegacyEventOrigins(db)).immediate()).toThrow("legacy_origin_rebuild_required");
      expect(db.query("SELECT * FROM events ORDER BY event_id").all()).toEqual(original);
      expect(db.query("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'kizuki_legacy_origin%'").get()).toBeNull();
    } finally { db.close(); }
  });
});
