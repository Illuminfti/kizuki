import { describe, expect, test } from "bun:test";
import {
  listLiveConflicts,
  listSubjectAliases,
  upsertIdentityLink,
} from "../../src/claims/identity";
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
});
