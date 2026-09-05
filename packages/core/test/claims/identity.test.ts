import { describe, expect, test } from "bun:test";
import {
  listLiveConflicts,
  listSubjectAliases,
  scanLegacyIdentityRows,
  upsertIdentityLink,
} from "../../src/claims/identity";
import { Database } from "bun:sqlite";
import { ClaimError } from "../../src/claims/errors";
import { insertClaim } from "../../src/claims/store";
import { openLedger } from "../../src/ledger/db";
import { eventFacts, putEvent } from "./helpers";

describe("identity aliases and live conflicts", () => {
  test("retires caller-controlled identity mutation and alias authority", () => {
    const db = openLedger(":memory:");
    expect(() => upsertIdentityLink(db, {
      subject_a: "person:ada", subject_b: "person:ada.lovelace", score: 1,
      evidence: ["event:evt-synthetic"], status: "merged", decided_by: "forged",
      receipt_id: "forged-receipt", at: "2026-09-04T00:00:00Z",
    })).toThrow(ClaimError);
    try { upsertIdentityLink(db, { subject_a: "person:ada", subject_b: "person:ada.lovelace", score: 1, evidence: ["event:evt-synthetic"], status: "merged", decided_by: "forged", at: "2026-09-04T00:00:00Z" }); }
    catch (error) {
      expect(error).toBeInstanceOf(ClaimError);
      expect((error as ClaimError).code).toBe("identity_unsupported");
      expect((error as Error).message).toContain("identity mutation API retired");
    }
    expect(db.query("SELECT 1 FROM identity_links").get()).toBeNull();
    expect(() => listSubjectAliases(db, "person:ada")).toThrow(
      "identity authority unavailable",
    );
    db.close();
  });

  test("surfaces a live conflict set for a single-valued predicate", async () => {
    const db = openLedger(":memory:");
    const left = putEvent(db, { source_record_id: "left" });
    const right = putEvent(db, { source_record_id: "right" });
    const first = await insertClaim(
      { db },
      {
        kind: "claim",
        subject: "person:ada",
        predicate: "employment.works_at",
        object: "Acme",
        polarity: "positive",
        body: "Ada works at Acme.",
        provenance: [left],
        subjects: ["person:ada"],
        producer: "deterministic",
        confidence: 0.7,
        events: [eventFacts(left)],
      },
    );
    const second = await insertClaim(
      { db },
      {
        kind: "claim",
        subject: "person:ada",
        predicate: "employment.works_at",
        object: "Contoso",
        polarity: "positive",
        body: "Ada works at Contoso.",
        provenance: [right],
        subjects: ["person:ada"],
        producer: "deterministic",
        confidence: 0.7,
        events: [eventFacts(right)],
      },
    );
    expect(first.outcome === "stored" || first.outcome === "contested").toBe(true);
    expect(second.outcome === "stored" || second.outcome === "contested").toBe(true);
    const conflicts = listLiveConflicts(db, { subject: "person:ada" });
    if (second.outcome === "skipped") {
      expect(conflicts).toEqual([]);
    } else {
      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts[0]?.claims.length).toBeGreaterThan(1);
    }
    db.close();
  });

  test("bounds SQLite legacy identity rows before payload use", () => {
    const db = openLedger(":memory:");
    db.query(
      `INSERT INTO identity_links
       (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run("x".repeat(1_025), "person:b", 1, "[]", "candidate", "legacy", "2026-09-05T00:00:00.000Z");
    expect(() => scanLegacyIdentityRows(db)).toThrow(/oversized/);
    db.close();
  });

  test("rejects aggregate legacy identity payloads within the individual row limit", () => {
    const db = openLedger(":memory:");
    const insert = db.query(
      `INSERT INTO identity_links
       (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    for (let index = 0; index < 90; index += 1)
      insert.run(`person:a-${index}`, `person:b-${index}`, 1, `"${"x".repeat(12_000)}"`, "candidate", "legacy", "2026-09-05T00:00:00.000Z");
    expect(() => scanLegacyIdentityRows(db)).toThrow(/aggregate/);
    db.close();
  });

  test("rejects non-text legacy storage even when SQLite compatibility tables are corrupt", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE identity_links (
      subject_a TEXT NOT NULL, subject_b TEXT NOT NULL, score REAL NOT NULL,
      evidence BLOB NOT NULL, status TEXT NOT NULL, decided_by TEXT NOT NULL,
      receipt_id TEXT, at TEXT NOT NULL, PRIMARY KEY (subject_a, subject_b)
    )`);
    db.query("INSERT INTO identity_links VALUES (?,?,?,?,?,?,NULL,?)")
      .run("person:a", "person:b", 1, Buffer.from("[]"), "candidate", "legacy", "2026-09-05T00:00:00.000Z");
    expect(() => scanLegacyIdentityRows(db)).toThrow(/malformed/);
    db.close();
  });
});
