import { expect, test } from "bun:test";
import { DisconnectError, disconnect, getConnection, registerConnection } from "../src/index";
import { openLedger } from "../src/ledger/db";

const SOURCE = "01JJ0000000000000000000001";

test("disconnect refuses an unknown identity without changing another connector", () => {
  const db = openLedger(":memory:");
  try {
    const enrolled = registerConnection(db, "fixture", SOURCE);
    try { disconnect(db, "other", SOURCE); throw new Error("unexpected success"); }
    catch (error) {
      expect(error).toBeInstanceOf(DisconnectError);
      expect(error).toMatchObject({ reason: "unknown_connection" });
    }
    expect(getConnection(db, "fixture", SOURCE)).toEqual(enrolled);
  } finally { db.close(); }
});

test("disconnect returns the recorded transition and a repeat preserves its first timestamp", () => {
  const db = openLedger(":memory:");
  try {
    registerConnection(db, "fixture", SOURCE);
    const result = disconnect(db, "fixture", SOURCE);
    const disconnected = getConnection(db, "fixture", SOURCE)!;
    if (disconnected.disconnected_at === null) throw new Error("transition was not persisted");
    expect(result).toEqual({ connector_id: "fixture", source_key: SOURCE, disconnected_at: disconnected.disconnected_at });
    expect(disconnected.disconnected_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    // A durable earlier timestamp makes accidental rewriting visible without sleeps.
    const at = "2026-01-01T00:00:00.000Z";
    db.query("UPDATE connections SET disconnected_at=? WHERE source_key=?").run(at, SOURCE);
    expect(() => disconnect(db, "fixture", SOURCE)).toThrow("already_disconnected");
    expect(getConnection(db, "fixture", SOURCE)?.disconnected_at).toBe(at);
  } finally { db.close(); }
});

test("disconnect refuses a suppressed database transition instead of reporting success", () => {
  const db = openLedger(":memory:");
  try {
    const enrolled = registerConnection(db, "fixture", SOURCE);
    db.exec("CREATE TRIGGER suppress_disconnect BEFORE UPDATE OF disconnected_at ON connections BEGIN SELECT RAISE(IGNORE); END");
    expect(() => disconnect(db, "fixture", SOURCE)).toThrow("connection_changed");
    expect(getConnection(db, "fixture", SOURCE)).toEqual(enrolled);
  } finally { db.close(); }
});
