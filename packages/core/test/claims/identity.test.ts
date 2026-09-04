import { describe, expect, test } from "bun:test";
import {
  listLiveConflicts,
  listSubjectAliases,
  upsertIdentityLink,
} from "../../src/claims/identity";
import { insertClaim } from "../../src/claims/store";
import { openLedger } from "../../src/ledger/db";
import { eventFacts, putEvent } from "./helpers";

describe("identity aliases and live conflicts", () => {
  test("lists aliases without exposing private evidence text", () => {
    const db = openLedger(":memory:");
    upsertIdentityLink(db, {
      subject_a: "person:ada",
      subject_b: "person:ada.lovelace",
      score: 0.92,
      evidence: ["evt-synthetic"],
      status: "candidate",
      decided_by: "test",
      at: "2026-09-04T00:00:00Z",
    });
    const aliases = listSubjectAliases(db, "person:ada");
    expect(aliases).toEqual([
      { subject: "person:ada.lovelace", score: 0.92, status: "candidate" },
    ]);
    expect(JSON.stringify(aliases)).not.toContain("evt-synthetic");
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
