import { expect, test } from "bun:test";
import { getClaim, insertClaim, pendingRetrievalOps, retryRetrievalOps } from "../../src/claims/store";
import { seedConnectorSensitivity } from "../../src/sensitivity/store";
import { claimInput, claimsDb, FixtureVectorPort, putEvent } from "./helpers";

test("exact replay retains a failed sensitivity refresh for recovery", async () => {
  const db = claimsDb();
  const retrieval = new FixtureVectorPort();
  try {
    seedConnectorSensitivity(db, { connector_id: "fixture", source_key: "fixture" }, {
      default_sensitivity: "public", sensitivity_floor: "public",
    });
    const eventId = putEvent(db);
    const first = await insertClaim({ db, retrieval }, claimInput(eventId));
    if (first.outcome !== "stored") throw new Error("expected stored claim");
    const upsert = retrieval.upsert.bind(retrieval);
    retrieval.upsert = async () => { throw new Error("fixture index unavailable"); };
    const replay = await insertClaim({ db, retrieval }, claimInput(eventId, { sensitivity: "private" }));
    if (replay.outcome !== "duplicate") throw new Error("expected duplicate claim");
    expect(replay.claim).toEqual({ ...first.claim, sensitivity: "private" });
    expect(getClaim(db, first.claim.claim_id)).toEqual(replay.claim);
    expect(pendingRetrievalOps(db).map(op => op.doc_id)).toEqual([first.claim.claim_id]);
    expect(retrieval.docs.get(`claim:${first.claim.claim_id}`)?.sensitivity).toBe("personal");

    retrieval.upsert = upsert;
    const recovered = await insertClaim({ db, retrieval }, claimInput(eventId));
    if (recovered.outcome !== "duplicate") throw new Error("expected duplicate recovery");
    expect(recovered.claim).toEqual(replay.claim);
    expect(pendingRetrievalOps(db)).toEqual([]);
    expect(retrieval.docs.get(`claim:${first.claim.claim_id}`)?.sensitivity).toBe("private");
    expect(getClaim(db, first.claim.claim_id)).toEqual(replay.claim);
    expect(await retryRetrievalOps({ db, retrieval })).toEqual({ retried: 0, pending: 0 });
  } finally {
    db.close();
  }
});

test("exact replay rolls back its label when the refresh cannot be queued", async () => {
  const db = claimsDb();
  const retrieval = new FixtureVectorPort();
  try {
    seedConnectorSensitivity(db, { connector_id: "fixture", source_key: "fixture" }, {
      default_sensitivity: "public", sensitivity_floor: "public",
    });
    const eventId = putEvent(db);
    const first = await insertClaim({ db, retrieval }, claimInput(eventId));
    if (first.outcome !== "stored") throw new Error("expected stored claim");
    db.exec(`CREATE TEMP TRIGGER fail_refresh BEFORE INSERT ON retrieval_ops
      BEGIN SELECT RAISE(ABORT, 'fixture queue unavailable'); END`);
    await expect(insertClaim({ db, retrieval }, claimInput(eventId, { sensitivity: "private" })))
      .rejects.toThrow("fixture queue unavailable");
    expect(getClaim(db, first.claim.claim_id)).toEqual(first.claim);
    expect(pendingRetrievalOps(db)).toEqual([]);
    expect(retrieval.docs.get(`claim:${first.claim.claim_id}`)?.sensitivity).toBe("personal");
    db.exec("DROP TRIGGER fail_refresh");
    const replay = await insertClaim({ db, retrieval }, claimInput(eventId, { sensitivity: "private" }));
    if (replay.outcome !== "duplicate") throw new Error("expected duplicate claim");
    expect(replay.claim).toEqual({ ...first.claim, sensitivity: "private" });
    expect(retrieval.docs.get(`claim:${first.claim.claim_id}`)?.sensitivity).toBe("private");
  } finally {
    db.close();
  }
});

for (const confirmedAt of [null, "2026-09-02T12:00:00.000Z"]) {
  test(`exact evidence replay tightens sensitivity without renewing ${confirmedAt} confirmation`, async () => {
    const db = claimsDb();
    const retrieval = new FixtureVectorPort();
    try {
      seedConnectorSensitivity(db, { connector_id: "fixture", source_key: "fixture" }, {
        default_sensitivity: "public", sensitivity_floor: "public",
      });
      const eventId = putEvent(db);
      const first = await insertClaim(
        { db, retrieval, now: () => "2026-09-02T12:00:00.000Z" },
        claimInput(eventId),
      );
      expect(first.outcome).toBe("stored");
      if (first.outcome !== "stored") throw new Error("expected stored claim");
      expect(first.claim.sensitivity).toBe("personal");
      db.query("UPDATE claims SET last_confirmed_at = ? WHERE claim_id = ?")
        .run(confirmedAt, first.claim.claim_id);
      const before = getClaim(db, first.claim.claim_id)!;
      const replay = await insertClaim(
        { db, retrieval, now: () => "2026-09-03T12:00:00.000Z" },
        claimInput(eventId, { sensitivity: "private" }),
      );
      expect(replay.outcome).toBe("duplicate");
      if (replay.outcome !== "duplicate") throw new Error("expected duplicate claim");
      expect(replay.claim).toEqual({ ...before, sensitivity: "private" });
      expect(getClaim(db, before.claim_id)).toEqual(replay.claim);
      expect(retrieval.docs.get(`claim:${before.claim_id}`)?.sensitivity).toBe("private");
      const again = await insertClaim({ db, retrieval }, claimInput(eventId));
      expect(again.outcome).toBe("duplicate");
      if (again.outcome !== "duplicate") throw new Error("expected duplicate replay");
      expect(again.claim).toEqual(replay.claim);
      expect(retrieval.docs.get(`claim:${before.claim_id}`)?.sensitivity).toBe("private");
    } finally {
      db.close();
    }
  });
}
