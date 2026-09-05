import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { accept, count, readEvent } from "../src/ledger/ledger";
import { commitMachineByteIntent, requireExternalEvents } from "../src/ledger/event-origin";
import { recordNativeCorrection } from "../src/correction/evidence";
import { sha256Hex } from "../src/util/hash";
import { ulid } from "../src/util/ulid";
import { validEvent } from "./fixtures";

function intent(db: ReturnType<typeof openLedger>, text: string): void {
  commitMachineByteIntent(db, { receipt_id: ulid(), before_hash: null, after_hash: sha256Hex(text) }, () => undefined);
}

describe("causal event admission", () => {
  test("a capture committed before matching machine bytes stays external", () => {
    const db = openLedger(":memory:");
    try {
      const stored = accept(db, validEvent());
      if (stored.status !== "stored") throw new Error("fixture capture failed");
      const original = db.query("SELECT * FROM events").get();
      intent(db, validEvent().text);
      expect(() => requireExternalEvents(db, [stored.event.event_id])).not.toThrow();
      expect(readEvent(db, stored.event.event_id)).toEqual(stored.event);
      expect(db.query("SELECT * FROM events").get()).toEqual(original);
    } finally { db.close(); }
  });

  test("an intent committed before capture produces an immutable self binding", () => {
    const db = openLedger(":memory:");
    try {
      intent(db, validEvent().text);
      const stored = accept(db, validEvent());
      if (stored.status !== "stored") throw new Error("fixture capture failed");
      expect(stored.event).toMatchObject({ origin: "self", origin_binding_version: 1, origin_binding_kind: "capture" });
      expect((stored.event as unknown as Record<string, unknown>)["origin_binding"]).toMatch(/^[a-f0-9]{64}$/);
      db.query("DELETE FROM canon_machine_byte_intents").run();
      expect(() => requireExternalEvents(db, [stored.event.event_id])).toThrow("machine origin");
      expect(readEvent(db, stored.event.event_id)).toEqual(stored.event);
    } finally { db.close(); }
  });

  test("duplicate redelivery after later intent keeps the original admission binding", () => {
    const db = openLedger(":memory:");
    try {
      const stored = accept(db, validEvent());
      if (stored.status !== "stored") throw new Error("fixture capture failed");
      const original = db.query("SELECT * FROM events").get();
      intent(db, validEvent().text);
      expect(accept(db, { ...validEvent(), observed_at: "2030-01-01T00:00:00Z" }).status).toBe("duplicate");
      expect(db.query("SELECT * FROM events").get()).toEqual(original);
    } finally { db.close(); }
  });

  test.each([
    "origin='self'", "event_id='01ARZ3NDEKTSV4RRFFQ69G5FAV'",
    "accepted_at='2030-01-01T00:00:00Z'", "content_hash='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
    "origin_binding_version=2", "origin_binding_kind='native'", "origin_binding=''",
    "text_hash='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'", "content_hash_version=1",
  ])("SQL refuses immutable admission changes: %s", (mutation) => {
    const db = openLedger(":memory:");
    try {
      expect(accept(db, validEvent()).status).toBe("stored");
      const original = db.query("SELECT * FROM events").get();
      expect(() => db.exec(`UPDATE events SET ${mutation}`)).toThrow();
      expect(db.query("SELECT * FROM events").get()).toEqual(original);
    } finally { db.close(); }
  });

  test("native event and proof are admitted without restamping public capture", () => {
    const db = openLedger(":memory:");
    try {
      db.exec("CREATE TRIGGER forbid_origin_restamp BEFORE UPDATE OF origin ON events BEGIN SELECT RAISE(ABORT,'native issuance must not restamp'); END");
      const input = { ...validEvent(), connector_id: "kizuki.owner", text: "KIZUKI CONTEXT v1 intentional native correction" };
      const native = recordNativeCorrection(db, input, sha256Hex("native-request"));
      expect(readEvent(db, native.event_id)).toMatchObject({ origin: "external", origin_binding_version: 1, origin_binding_kind: "native" });
      expect(accept(db, { ...input, source_record_id: "captured-owner-label" }))
        .toMatchObject({ status: "stored", event: { origin: "self", origin_binding_kind: "capture" } });
    } finally { db.close(); }
  });

  test("capture and its admission binding roll back with the enclosing source transaction", () => {
    const db = openLedger(":memory:");
    try {
      intent(db, validEvent().text);
      expect(() => db.transaction(() => {
        expect(accept(db, validEvent())).toMatchObject({ status: "stored", event: { origin: "self" } });
        throw new Error("synthetic enclosing rollback");
      }).immediate()).toThrow("synthetic enclosing rollback");
      expect(count(db)).toBe(0);
    } finally { db.close(); }
  });

  test("failed native proof insertion leaves neither event nor proof", () => {
    const db = openLedger(":memory:");
    try {
      db.exec("CREATE TRIGGER fail_native BEFORE INSERT ON native_owner_evidence BEGIN SELECT RAISE(ABORT,'synthetic proof failure'); END");
      expect(() => recordNativeCorrection(db, { ...validEvent(), connector_id: "kizuki.owner" }, sha256Hex("request")))
        .toThrow("synthetic proof failure");
      expect(count(db)).toBe(0);
      expect(db.query("SELECT 1 FROM native_owner_evidence").get()).toBeNull();
    } finally { db.close(); }
  });

  test("native proof identity is immutable while its filing state may advance", () => {
    const db = openLedger(":memory:");
    try {
      const native = recordNativeCorrection(db, { ...validEvent(), connector_id: "kizuki.owner" }, sha256Hex("request"));
      for (const mutation of ["request_digest='" + "e".repeat(64) + "'", "recorded_at='2030-01-01T00:00:00Z'",
        "event_id='01ARZ3NDEKTSV4RRFFQ69G5FAV'", "event_content_hash='" + "f".repeat(64) + "'"]) {
        expect(() => db.exec(`UPDATE native_owner_evidence SET ${mutation}`)).toThrow("immutable");
      }
      db.exec("UPDATE native_owner_evidence SET filing_state='filed'");
      expect(readEvent(db, native.event_id)?.origin).toBe("external");
    } finally { db.close(); }
  });

  test("all read and duplicate paths reject an origin edit even if SQL guards were removed", () => {
    const db = openLedger(":memory:");
    try {
      const stored = accept(db, validEvent());
      if (stored.status !== "stored") throw new Error("fixture failed");
      db.exec("DROP TRIGGER events_identity_update; UPDATE events SET origin='self'");
      expect(() => readEvent(db, stored.event.event_id)).toThrow("event record is invalid");
      expect(accept(db, validEvent())).toMatchObject({ status: "error", kind: "infrastructure" });
      expect(() => requireExternalEvents(db, [stored.event.event_id])).toThrow("event record is invalid");
    } finally { db.close(); }
  });
});
