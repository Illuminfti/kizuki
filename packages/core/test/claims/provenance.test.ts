import { describe, expect, test } from "bun:test";
import { SINGLE_SOURCE_CAP } from "../../src/claims/authority";
import { ClaimError } from "../../src/claims/errors";
import { seedConnectorSensitivity } from "../../src/sensitivity/store";
import {
  getClaim,
  insertClaim,
  listClaims,
  listSupersessions,
  markClaimsPurged,
  prepareClaimInsert,
} from "../../src/claims/store";
import { claimInput, claimsDb, eventFacts, FixtureVectorPort, putEvent } from "./helpers";

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

  test("rephrasing existing evidence preserves confidence and freshness", async () => {
    const db = claimsDb();
    try {
      const eventId = putEvent(db);
      const first = await insertClaim(
        { db, now: () => "2026-09-02T12:00:00.000Z" },
        claimInput(eventId, { confidence: 0.2 }),
      );
      expect(first.outcome).toBe("stored");
      if (first.outcome !== "stored") throw new Error("expected stored");
      for (const body of ["Grace works at Acme.", "Acme employs Grace."]) {
        const replay = await insertClaim(
          { db, now: () => "2026-09-02T12:05:00.000Z" },
          claimInput(eventId, { body, confidence: 0.9 }),
        );
        expect(replay.outcome).toBe("duplicate");
        if (replay.outcome !== "duplicate") throw new Error("expected duplicate");
        expect(replay.claim).toEqual(first.claim);
        expect(getClaim(db, first.claim.claim_id)).toEqual(first.claim);
      }
      expect(listSupersessions(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("structural corroboration requires overlapping validity", async () => {
    const cases = [
      {
        name: "disjoint",
        incoming: { valid_from: "2026-09-01T00:00:00.000Z", valid_to: null },
        outcome: "stored",
        rows: 2,
      },
      {
        name: "adjacent",
        incoming: { valid_from: "2026-02-01T00:00:00.000Z", valid_to: "2026-03-01T00:00:00.000Z" },
        outcome: "stored",
        rows: 2,
      },
      {
        name: "overlap",
        incoming: { valid_from: "2026-01-15T00:00:00.000Z", valid_to: "2026-02-15T00:00:00.000Z" },
        outcome: "duplicate",
        rows: 1,
      },
      {
        name: "open-ended overlap",
        incoming: { valid_from: "2026-01-15T00:00:00.000Z", valid_to: null },
        outcome: "duplicate",
        rows: 1,
      },
    ] as const;

    for (const fixture of cases) {
      const db = claimsDb();
      try {
        const firstEvent = putEvent(db, { source_record_id: `${fixture.name}-first` });
        const secondEvent = putEvent(db, { source_record_id: `${fixture.name}-second` });
        const first = await insertClaim({ db }, claimInput(firstEvent, {
          body: "Grace worked at Acme during January.",
          valid_from: "2026-01-01T00:00:00.000Z",
          valid_to: "2026-02-01T00:00:00.000Z",
        }));
        expect(first.outcome).toBe("stored");

        const second = await insertClaim({ db }, claimInput(secondEvent, {
          body: "A separately dated observation places Grace at Acme.",
          ...fixture.incoming,
        }));
        expect(second.outcome).toBe(fixture.outcome);
        expect(listClaims(db)).toHaveLength(fixture.rows);
        if (second.outcome === "duplicate") {
          expect(second.claim.corroboration).toBe(2);
          expect(second.claim.provenance).toEqual([firstEvent, secondEvent]);
        }
      } finally {
        db.close();
      }
    }
  });

  test("unchanged structural replay adds no retrieval work but changes still refresh", async () => {
    const db = claimsDb();
    const retrieval = new FixtureVectorPort({ vector: false });
    try {
      seedConnectorSensitivity(db, { connector_id: "fixture", source_key: "fixture" }, {
        default_sensitivity: "public", sensitivity_floor: "public",
      });
      const eventId = putEvent(db);
      const io = { db, retrieval };
      const first = await insertClaim(io, claimInput(eventId));
      if (first.outcome !== "stored") throw new Error("expected stored");
      const operations = () => db.query("SELECT * FROM retrieval_ops ORDER BY op_id").all();
      const initialOps = operations();
      expect(initialOps).toHaveLength(1);
      const replay = await insertClaim(io, claimInput(eventId, { body: "Grace works at Acme." }));
      expect(replay.outcome).toBe("duplicate");
      expect(operations()).toEqual(initialOps);
      const tightened = await insertClaim(io, claimInput(eventId, {
        body: "Acme employs Grace.", sensitivity: "private",
      }));
      if (tightened.outcome !== "duplicate") throw new Error("expected duplicate");
      expect(operations()).toHaveLength(2);
      expect(retrieval.docs.get(`claim:${first.claim.claim_id}`)?.sensitivity).toBe("private");
      const secondEvent = putEvent(db, { connector_id: "other-fixture" });
      await insertClaim(io, claimInput(secondEvent, { body: "Another source: Grace works at Acme." }));
      expect(operations()).toHaveLength(3);
      expect(retrieval.docs.get(`claim:${first.claim.claim_id}`)?.provenance).toEqual([eventId, secondEvent]);
    } finally {
      db.close();
    }
  });

  test("rolled-back corroboration leaves no support or retrieval work and can retry", async () => {
    const db = claimsDb();
    try {
      seedConnectorSensitivity(db, { connector_id: "fixture", source_key: "fixture" }, {
        default_sensitivity: "public", sensitivity_floor: "public",
      });
      const firstEvent = putEvent(db);
      const secondEvent = putEvent(db, { source_record_id: "retry-support" });
      const io = { db, retrieval: new FixtureVectorPort({ vector: false }) };
      const first = await insertClaim(io, claimInput(firstEvent));
      if (first.outcome !== "stored") throw new Error("expected stored");
      const operations = () => db.query("SELECT * FROM retrieval_ops ORDER BY op_id").all();
      const initialOps = operations();
      const prepared = await prepareClaimInsert(io, claimInput(secondEvent, {
        body: "Another record confirms Grace works at Acme.", sensitivity: "private",
      }));
      expect(() => db.transaction(() => {
        const result = prepared.apply();
        if (result.outcome !== "duplicate") throw new Error("expected duplicate");
        expect(result.claim.provenance).toEqual([firstEvent, secondEvent]);
        expect(result.claim.sensitivity).toBe("private");
        throw new Error("abort extraction transaction");
      })()).toThrow("abort extraction transaction");
      expect(getClaim(db, first.claim.claim_id)).toEqual(first.claim);
      expect(operations()).toEqual(initialOps);

      const retried = db.transaction(() => prepared.apply())();
      if (retried.outcome !== "duplicate") throw new Error("expected duplicate");
      expect(retried.claim.provenance).toEqual([firstEvent, secondEvent]);
      expect(retried.claim.sensitivity).toBe("private");
      expect(retried.claim.corroboration).toBe(first.claim.corroboration + 1);
      expect(getClaim(db, first.claim.claim_id)).toEqual(retried.claim);
      expect(operations()).toHaveLength(initialOps.length + 1);
      const replayed = db.transaction(() => prepared.apply())();
      if (replayed.outcome !== "duplicate") throw new Error("expected duplicate");
      expect(replayed.claim).toEqual(retried.claim);
      expect(operations()).toHaveLength(initialOps.length + 1);
    } finally {
      db.close();
    }
  });

  test("reordered citations remain a replay while new support is retained", async () => {
    const db = claimsDb();
    try {
      const evidence = Array.from({ length: 32 }, (_, index) => putEvent(db, {
        source_record_id: `support-${index}`,
      }));
      const first = await insertClaim({ db }, claimInput(evidence[0]!, {
        provenance: evidence,
      }));
      if (first.outcome !== "stored") throw new Error("expected stored");
      const replay = await insertClaim({ db }, claimInput(evidence[0]!, {
        body: "Grace works at Acme, according to the same records.",
        provenance: [...evidence].reverse(),
      }));
      expect(replay.outcome).toBe("duplicate");
      if (replay.outcome !== "duplicate") throw new Error("expected duplicate");
      expect(replay.claim).toEqual(first.claim);
      expect(getClaim(db, first.claim.claim_id)).toEqual(first.claim);

      const newEvent = putEvent(db, { source_record_id: "new-support" });
      const confirmed = await insertClaim({ db }, claimInput(newEvent, {
        body: "One more record confirms Grace works at Acme.",
        provenance: [...evidence].reverse().concat(newEvent),
      }));
      if (confirmed.outcome !== "duplicate") throw new Error("expected duplicate");
      expect(confirmed.claim.provenance).toEqual([...evidence, newEvent]);
      expect(confirmed.claim.corroboration).toBe(first.claim.corroboration + 1);
      expect(getClaim(db, first.claim.claim_id)).toEqual(confirmed.claim);
    } finally {
      db.close();
    }
  });

  test("sensitivity-only replay tightens policy without confirming evidence", async () => {
    const db = claimsDb();
    try {
      seedConnectorSensitivity(db, { connector_id: "fixture", source_key: "fixture" }, {
        default_sensitivity: "public", sensitivity_floor: "public",
      });
      const eventId = putEvent(db);
      const first = await insertClaim(
        { db, now: () => "2026-09-02T12:00:00.000Z" },
        claimInput(eventId, { confidence: 0.2 }),
      );
      if (first.outcome !== "stored") throw new Error("expected stored");
      const replay = await insertClaim(
        { db, now: () => "2026-09-02T12:05:00.000Z" },
        claimInput(eventId, {
          body: "Grace works at Acme.", confidence: 0.9, sensitivity: "private",
        }),
      );
      expect(replay.outcome).toBe("duplicate");
      if (replay.outcome !== "duplicate") throw new Error("expected duplicate");
      const tightened = { ...first.claim, sensitivity: "private" as const };
      expect(replay.claim).toEqual(tightened);
      expect(getClaim(db, first.claim.claim_id)).toEqual(tightened);
      const lower = await insertClaim({ db }, claimInput(eventId, {
        body: "Acme employs Grace.", sensitivity: "personal",
      }));
      if (lower.outcome !== "duplicate") throw new Error("expected duplicate");
      expect(lower.claim).toEqual(tightened);
    } finally {
      db.close();
    }
  });

  test("corroborating evidence retains sensitivity and purge lineage", async () => {
    const db = claimsDb();
    try {
      const firstEvent = putEvent(db);
      const secondEvent = putEvent(db, { connector_id: "other-fixture" });
      const first = await insertClaim({ db }, claimInput(firstEvent));
      if (first.outcome !== "stored") throw new Error("expected stored");
      const second = await insertClaim({ db }, claimInput(secondEvent, {
        body: "Another note: Grace works at Acme.",
        provenance: [firstEvent, secondEvent],
        sensitivity: "private",
      }));
      expect(second.outcome).toBe("duplicate");
      if (second.outcome !== "duplicate") throw new Error("expected duplicate");
      expect(second.claim.sensitivity).toBe("private");
      expect(second.claim.provenance).toEqual([firstEvent, secondEvent]);
      expect(getClaim(db, first.claim.claim_id)).toEqual(second.claim);
      db.query("DELETE FROM events WHERE event_id = ?").run(firstEvent);
      expect(markClaimsPurged(db)).toEqual([]);
      db.query("DELETE FROM events WHERE event_id = ?").run(secondEvent);
      expect(markClaimsPurged(db)).toEqual([first.claim.claim_id]);
    } finally {
      db.close();
    }
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
    expect(first.claim.authority).toBe("model_inference");
    expect(first.claim.confidence).toBe(SINGLE_SOURCE_CAP);

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
    expect(second.claim.authority).toBe("connector_evidence");
    expect(second.claim.last_confirmed_at).toBe("2026-09-02T12:05:00.000Z");
    expect(second.claim.provenance).toEqual([firstEvent, secondEvent]);
    const replay = await insertClaim(
      { db, now: () => "2026-09-02T12:10:00.000Z" },
      claimInput(secondEvent, {
        confidence: 0.9,
        body: "Rephrased independent note: Grace works at Acme.",
      }),
    );
    expect(replay.outcome).toBe("duplicate");
    if (replay.outcome !== "duplicate") throw new Error("expected duplicate");
    expect(replay.claim).toEqual(second.claim);
    expect(getClaim(db, first.claim.claim_id)).toEqual(second.claim);
    expect(listSupersessions(db)).toEqual([]);
    db.close();
  });
});
