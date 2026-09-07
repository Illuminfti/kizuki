import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectOpenLedgerHealth, openLedger } from "../src/ledger/db";
import { accept, readSince } from "../src/ledger/ledger";
import { validEvent } from "./fixtures";

test("doctor accepts a genuine historical writer's event after ledger15 migration", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-doctor-legacy-")), path = join(root, "ledger.sqlite");
  try {
    const original = new Database(path);
    try {
      original.exec(readFileSync(join(import.meta.dir, "fixtures/doctor-ledger15-legacy.sql"), "utf8"));
      expect(original.query("SELECT version FROM schema_version").get()).toEqual({ version: 15 });
    } finally { original.close(true); }
    const db = openLedger(path);
    try {
      expect(readSince(db, null, 1).events[0]).toMatchObject({
        event_id: "01BBBBBBBBBBBBBBBBBBBBBBBB", content_hash_version: 1,
      });
      expect(inspectOpenLedgerHealth(db, { full: true })).toMatchObject({
        ok: true, sampled_events: 1, failures: [], quick_check: "ok", integrity_check: "ok",
      });
      expect(db.query("SELECT count(*) AS n FROM agents").get()).toEqual({ n: 0 });
    } finally { db.close(true); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("doctor preserves its schema diagnosis when an identity column cannot be sampled", () => {
  const db = openLedger(":memory:");
  try {
    db.exec("DROP TRIGGER events_identity_insert; DROP TRIGGER events_identity_update; ALTER TABLE events DROP COLUMN origin_binding");
    const report = inspectOpenLedgerHealth(db);
    expect(report.ok).toBe(false);
    expect(report.sampled_events).toBe(0);
    expect(report.failures.some(failure => failure.kind === "schema")).toBe(true);
  } finally { db.close(true); }
});

for (const [field, value] of [
  ["text", "changed synthetic payload"],
  ["metadata", '{"synthetic":"changed"}'],
  ["content_hash", "a".repeat(64)],
  ["content_hash_version", 3],
  ["text_hash", "b".repeat(64)],
  ["origin_binding", "c".repeat(64)],
  ["origin", "self"],
  ["accepted_at", "2020-01-01T00:00:00Z"],
] as const) test(`doctor and authoritative reads both reject ${field} drift`, () => {
  const db = openLedger(":memory:");
  try {
    expect(accept(db, validEvent()).status).toBe("stored");
    expect(inspectOpenLedgerHealth(db, { full: true })).toMatchObject({
      ok: true, sampled_events: 1, failures: [], quick_check: "ok", integrity_check: "ok",
    });
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DROP TRIGGER events_identity_update; PRAGMA ignore_check_constraints = ON");
      db.run(`UPDATE events SET ${field} = ?`, [value]);
      expect(() => readSince(db, null, 1)).toThrow();
      const health = inspectOpenLedgerHealth(db);
      expect(health.ok).toBe(false);
      expect(health.failures.some(failure => failure.kind === "row" && failure.table === "events")).toBe(true);
      expect(JSON.stringify(health)).not.toContain(validEvent().text);
      expect(JSON.stringify(health)).not.toContain("changed synthetic payload");
    } finally { db.exec("ROLLBACK; PRAGMA ignore_check_constraints = OFF"); }
    expect(readSince(db, null, 1).events).toHaveLength(1);
    expect(inspectOpenLedgerHealth(db)).toMatchObject({ ok: true, failures: [] });
  } finally { db.close(true); }
});
