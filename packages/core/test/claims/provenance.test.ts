import { describe, expect, test } from "bun:test";
import { ClaimError } from "../../src/claims/errors";
import {
  getClaim,
  insertClaim,
  listSupersessions,
  markClaimsPurged,
} from "../../src/claims/store";
import { claimInput, claimsDb, eventFacts, putEvent } from "./helpers";

describe("claims provenance", () => {
  test("a claim citing an unknown event id is refused", async () => {
    const db = claimsDb();
    expect(
      insertClaim(
        { db },
        claimInput("01MISSINGEVENT000000000001", {
          events: [eventFacts("01MISSINGEVENT000000000001")],
        }),
      ),
    ).rejects.toMatchObject({
      name: "ClaimError",
      code: "provenance_unresolved",
    });
    expect(() => {
      throw new ClaimError("provenance_unresolved", "probe");
    }).toThrow(/provenance_unresolved/);
    db.close();
  });

  test("purging every cited event marks the claim purged", async () => {
    const db = claimsDb();
    const eventId = putEvent(db);
    const stored = await insertClaim(
      { db },
      claimInput(eventId, { events: [eventFacts(eventId)] }),
    );
    expect(stored.outcome).toBe("stored");
    if (stored.outcome !== "stored") return;

    db.query("DELETE FROM events WHERE event_id = ?").run(eventId);
    expect(markClaimsPurged(db)).toEqual([stored.claim.claim_id]);
    expect(getClaim(db, stored.claim.claim_id)?.status).toBe("purged");
    db.close();
  });

  test("corroboration raises confidence and creates no supersession", async () => {
    const db = claimsDb();
    const firstEvent = putEvent(db, { source_record_id: "rec-a" });
    const secondEvent = putEvent(db, {
      source_record_id: "rec-b",
      connector_id: "other-fixture",
      text: "Grace works on partnerships at Acme.",
    });
    const first = await insertClaim(
      { db, now: () => "2026-09-02T12:00:00.000Z" },
      claimInput(firstEvent, {
        confidence: 0.55,
        body: "Grace runs partnerships at Acme.",
        events: [eventFacts(firstEvent)],
      }),
    );
    expect(first.outcome).toBe("stored");
    if (first.outcome !== "stored") return;

    const second = await insertClaim(
      { db, now: () => "2026-09-02T12:05:00.000Z" },
      claimInput(secondEvent, {
        confidence: 0.8,
        body: "Independent note: Grace works at Acme.",
        object: "Acme.",
        events: [
          eventFacts(secondEvent, {
            connector_id: "other-fixture",
            text: "Grace works on partnerships at Acme.",
          }),
        ],
      }),
    );
    expect(second.outcome).toBe("duplicate");
    if (second.outcome !== "duplicate") return;
    expect(second.claim.claim_id).toBe(first.claim.claim_id);
    expect(second.claim.confidence).toBe(0.8);
    expect(second.claim.corroboration).toBe(2);
    expect(second.claim.last_confirmed_at).toBe("2026-09-02T12:05:00.000Z");
    expect(listSupersessions(db)).toEqual([]);
    db.close();
  });
});
