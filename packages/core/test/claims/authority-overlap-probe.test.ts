import { describe, expect, test } from "bun:test";
import {
  claimsConflict,
  resolveConflict,
  validityOverlaps,
} from "../../src/claims/conflict";
import { getClaim, insertClaim, listSupersessions, markClaimsPurged } from "../../src/claims/store";
import {
  claimInput,
  claimsDb,
  corroboratedFacts,
  putEvent,
  nativeOwnerEvent,
  FixtureVectorPort,
} from "./helpers";

async function overlappingClaims(
  otherAuthority: "owner" | "connector",
  options: {
    reverseOrder?: boolean;
    reverseIntervals?: boolean;
    firstConfidence?: number;
    otherConfidence?: number;
  } = {},
) {
  const db = claimsDb();
  const retrieval = new FixtureVectorPort({ vector: false });
  const io = { db, retrieval, now: () => "2026-09-02T12:00:00.000Z" };
  const firstEvent = putEvent(db, { source_record_id: "overlap-first" });
  const secondEvent = putEvent(db, { source_record_id: "overlap-second", connector_id: "other-fixture" });
  const provenance = [firstEvent, secondEvent];
  const events = corroboratedFacts(firstEvent, secondEvent);
  const past = { valid_from: "2026-01-01T00:00:00.000Z", valid_to: "2026-03-01T00:00:00.000Z" };
  const future = { valid_from: "2026-06-01T00:00:00.000Z", valid_to: null };
  const firstInput = claimInput(firstEvent, {
    claim_id: "01CLAIM000000000000000000A",
    provenance, events, confidence: options.firstConfidence ?? 0.6,
    ...(options.reverseIntervals ? future : past),
  });
  const otherBody = "Grace works at Northwind.";
  const otherInput = claimInput(firstEvent, {
    claim_id: "01CLAIM000000000000000000B",
    body: otherBody, object: "northwind",
    provenance, events, confidence: options.otherConfidence ?? 1,
    ...(options.reverseIntervals ? past : future),
    ...(otherAuthority === "owner" ? {
      provenance: [nativeOwnerEvent(db, otherBody)],
      producer: "owner" as const, intent: "correct" as const,
    } : {}),
  });
  for (const input of options.reverseOrder ? [otherInput, firstInput] : [firstInput, otherInput]) {
    const inserted = await insertClaim(io, input);
    expect(inserted.outcome).toBe("stored");
  }
  const first = getClaim(db, firstInput.claim_id!);
  const other = getClaim(db, otherInput.claim_id!);
  if (first === null || other === null) throw new Error("overlap fixture claims were not stored");
  expect(first.authority).toBe("connector_evidence");
  expect(other.authority).toBe(otherAuthority === "owner" ? "owner_correction" : "connector_evidence");
  expect(validityOverlaps(first, other)).toBe(false);
  expect(claimsConflict(first, other)).toBe(false);
  expect(retrieval.docs.size).toBe(2);
  // The live-key query walks the validity index, not insertion order.
  // Reverse SQLite's unordered scan explicitly to exercise both conflict orders.
  if (options.reverseOrder) db.exec("PRAGMA reverse_unordered_selects = ON");
  const walk = db.query<{ claim_id: string }, [string]>(
    "SELECT claim_id FROM claims WHERE claim_key = ? AND status = 'live'",
  ).all(first.claim_key!).map(row => row.claim_id);
  const chronological = options.reverseIntervals ? [other.claim_id, first.claim_id] : [first.claim_id, other.claim_id];
  expect(walk).toEqual(options.reverseOrder ? chronological.toReversed() : chronological);

  const incoming = claimInput(firstEvent, {
    claim_id: "01CLAIM000000000000000000C",
    provenance, events, body: "Grace moved to Contoso.", object: "contoso", confidence: 0.8,
    valid_from: "2026-02-01T00:00:00.000Z", valid_to: "2026-07-01T00:00:00.000Z",
  });
  const snapshot = () => ({
    first: getClaim(db, first.claim_id), other: getClaim(db, other.claim_id),
    supersessions: listSupersessions(db),
    retrievalOps: db.query("SELECT * FROM retrieval_ops ORDER BY op_id").all(),
    documents: structuredClone([...retrieval.docs.entries()]),
  });
  return { db, io, retrieval, first, other, incoming, snapshot };
}

describe("insertClaim mixed-authority overlap probe", () => {
  test("a below-authority skip does not keep an earlier R3 supersession", async () => {
    const db = claimsDb();
    const first = putEvent(db, { source_record_id: "rec-a" });
    const second = putEvent(db, {
      source_record_id: "rec-b",
      connector_id: "other-fixture",
    });
    const ids: [string, string] = [first, second];
    const facts = corroboratedFacts(first, second);

    const earlier = await insertClaim(
      { db, now: () => "2026-09-02T12:00:00.000Z" },
      claimInput(ids[0], {
        claim_id: "01CLAIM000000000000000000A",
        provenance: ids,
        object: "acme",
        confidence: 0.6,
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_to: "2026-03-01T00:00:00.000Z",
        events: facts,
      }),
    );
    expect(earlier.outcome).toBe("stored");
    if (earlier.outcome !== "stored") return;
    expect(earlier.claim.authority).toBe("connector_evidence");

    const ownerEvent = nativeOwnerEvent(db, "Grace later joined Northwind.");
    const owner = await insertClaim(
      { db, now: () => "2026-09-02T12:01:00.000Z" },
      claimInput(ownerEvent, {
        claim_id: "01CLAIM000000000000000000B",
        provenance: [ownerEvent],
        body: "Grace later joined Northwind.",
        object: "northwind",
        producer: "owner",
        intent: "correct",
        confidence: 1,
        valid_from: "2026-06-01T00:00:00.000Z",
      }),
    );
    expect(owner.outcome).toBe("stored");
    if (owner.outcome !== "stored") return;
    expect(owner.claim.authority).toBe("owner_correction");
    expect(owner.claim.claim_key).toBe(earlier.claim.claim_key);
    expect(owner.claim.claim_key).not.toBeNull();
    expect(validityOverlaps(earlier.claim, owner.claim)).toBe(false);
    expect(claimsConflict(earlier.claim, owner.claim)).toBe(false);

    const key = earlier.claim.claim_key;
    if (key === null) return;
    const walk = db
      .query<{ claim_id: string }, [string]>(
        `SELECT claim_id FROM claims WHERE claim_key = ? AND status = 'live'`,
      )
      .all(key)
      .map((row) => row.claim_id);
    expect(walk).toEqual([earlier.claim.claim_id, owner.claim.claim_id]);

    const incoming = await insertClaim(
      { db, now: () => "2026-09-02T12:02:00.000Z" },
      claimInput(ids[0], {
        claim_id: "01CLAIM000000000000000000C",
        provenance: ids,
        body: "Grace moved to Contoso.",
        object: "contoso",
        confidence: 0.8,
        valid_from: "2026-02-01T00:00:00.000Z",
        valid_to: "2026-07-01T00:00:00.000Z",
        events: facts,
      }),
    );
    expect(incoming.outcome).toBe("skipped");
    if (incoming.outcome !== "skipped") return;
    expect(incoming.reason).toBe("below_authority");
    expect(incoming.claim.authority).toBe("connector_evidence");
    expect(resolveConflict(incoming.claim, earlier.claim)).toEqual({
      action: "supersede",
      winner: "incoming",
      rule: "R3",
    });
    expect(resolveConflict(incoming.claim, owner.claim)).toEqual({
      action: "skip",
      reason: "below_authority",
      rule: "R1",
    });
    expect(claimsConflict(incoming.claim, earlier.claim)).toBe(true);
    expect(claimsConflict(incoming.claim, owner.claim)).toBe(true);

    const earlierAfter = getClaim(db, earlier.claim.claim_id);
    expect({
      earlier_status: earlierAfter?.status,
      earlier_valid_to: earlierAfter?.valid_to,
      earlier_superseded_by: earlierAfter?.superseded_by,
      owner_status: getClaim(db, owner.claim.claim_id)?.status,
      incoming_status: getClaim(db, incoming.claim.claim_id)?.status,
      supersessions: listSupersessions(db),
    }).toEqual({
      earlier_status: "live",
      earlier_valid_to: "2026-03-01T00:00:00.000Z",
      earlier_superseded_by: null,
      owner_status: "live",
      incoming_status: "skipped",
      supersessions: [],
    });
    db.close();
  });
});

describe("claim admission across every overlapping interval", () => {
  test.each([
    ["earlier evidence, forward walk", false, false],
    ["earlier evidence, reverse walk", true, false],
    ["later evidence, forward walk", false, true],
    ["later evidence, reverse walk", true, true],
  ] as const)("an owner refusal preserves claims and retrieval (%s)", async (_label, reverseOrder, reverseIntervals) => {
    const fixture = await overlappingClaims("owner", { reverseOrder, reverseIntervals });
    const { db, io, first, other, incoming, snapshot } = fixture;
    try {
      const before = snapshot();
      const result = await insertClaim(io, incoming);
      expect(result.outcome).toBe("skipped");
      if (result.outcome !== "skipped") throw new Error("expected owner refusal");
      expect(result.reason).toBe("below_authority");
      expect(claimsConflict(result.claim, first)).toBe(true);
      expect(claimsConflict(result.claim, other)).toBe(true);
      expect(resolveConflict(result.claim, first)).toEqual({
        action: "supersede", winner: reverseIntervals ? "live" : "incoming", rule: "R3",
      });
      expect(resolveConflict(result.claim, other)).toEqual({ action: "skip", reason: "below_authority", rule: "R1" });
      expect(getClaim(db, result.claim.claim_id)?.status).toBe("skipped");
      expect(snapshot()).toEqual(before);
    } finally { db.close(); }
  });

  test.each([["forward", false], ["reverse", true]] as const)("a same-tier live winner cancels every tentative win (%s walk)", async (_label, reverseOrder) => {
    const { db, io, first, other, incoming, snapshot } = await overlappingClaims("connector", { reverseOrder });
    try {
      const before = snapshot();
      const result = await insertClaim(io, incoming);
      expect(result.outcome).toBe("skipped");
      if (result.outcome !== "skipped") throw new Error("expected same-tier refusal");
      expect(resolveConflict(result.claim, first)).toEqual({ action: "supersede", winner: "incoming", rule: "R3" });
      expect(resolveConflict(result.claim, other)).toEqual({ action: "supersede", winner: "live", rule: "R3" });
      expect(getClaim(db, result.claim.claim_id)?.status).toBe("skipped");
      expect(snapshot()).toEqual(before);
    } finally { db.close(); }
  });

  test.each([["forward", false], ["reverse", true]] as const)("an admitted owner correction supersedes both intervals (%s walk)", async (_label, reverseOrder) => {
    const { db, io, retrieval, first, other, incoming } = await overlappingClaims("connector", { reverseOrder });
    try {
      const result = await insertClaim(io, {
        ...incoming, producer: "owner", intent: "correct", confidence: 1,
        provenance: [nativeOwnerEvent(db, incoming.body)],
      });
      expect(result.outcome).toBe("stored");
      if (result.outcome !== "stored") throw new Error("expected admitted correction");
      expect(result.claim.status).toBe("live");
      expect(result.superseded.toSorted((a, b) => a.claim_id.localeCompare(b.claim_id))).toEqual([
        { claim_id: first.claim_id, rule: "R5" }, { claim_id: other.claim_id, rule: "R5" },
      ]);
      for (const prior of [first, other]) {
        expect(getClaim(db, prior.claim_id)).toMatchObject({
          status: "superseded", superseded_by: result.claim.claim_id,
          valid_to: incoming.valid_from, retracted_at: io.now(),
        });
      }
      expect(listSupersessions(db).toSorted((a, b) => a.loser.localeCompare(b.loser))).toEqual([
        { winner: result.claim.claim_id, loser: first.claim_id, rule: "R5" },
        { winner: result.claim.claim_id, loser: other.claim_id, rule: "R5" },
      ]);
      expect([...retrieval.docs.keys()]).toEqual([`claim:${result.claim.claim_id}`]);
      expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM retrieval_ops WHERE state = 'pending'").get()?.n).toBe(0);
    } finally { db.close(); }
  });

  test.each([["forward", false], ["reverse", true]] as const)("an admitted R4 contest keeps the contested claim live (%s walk)", async (_label, reverseOrder) => {
    const { db, io, retrieval, first, other, incoming } = await overlappingClaims("connector", {
      reverseOrder, firstConfidence: 0.4, otherConfidence: 0.8,
    });
    try {
      const result = await insertClaim(io, { ...incoming, confidence: 0.7 });
      expect(result.outcome).toBe("contested");
      if (result.outcome !== "contested") throw new Error("expected admitted contest");
      expect(resolveConflict(result.incoming, first)).toEqual({ action: "supersede", winner: "incoming", rule: "R3" });
      expect(resolveConflict(result.incoming, other)).toEqual({ action: "contested", rule: "R4" });
      expect(result.live.claim_id).toBe(other.claim_id);
      expect(getClaim(db, first.claim_id)?.status).toBe("superseded");
      expect(getClaim(db, other.claim_id)).toEqual(other);
      expect(getClaim(db, result.incoming.claim_id)?.status).toBe("live");
      expect(listSupersessions(db)).toEqual([{ winner: result.incoming.claim_id, loser: first.claim_id, rule: "R3" }]);
      expect([...retrieval.docs.keys()].sort()).toEqual([`claim:${other.claim_id}`, `claim:${result.incoming.claim_id}`].sort());
    } finally { db.close(); }
  });

  test("purged evidence remains purged and cannot block fresh evidence", async () => {
    const { db, io, first, other, incoming } = await overlappingClaims("connector");
    try {
      for (const eventId of first.provenance) db.query("DELETE FROM events WHERE event_id = ?").run(eventId);
      expect(markClaimsPurged(db).sort()).toEqual([first.claim_id, other.claim_id].sort());
      const one = putEvent(db, { source_record_id: "fresh-one" });
      const two = putEvent(db, { source_record_id: "fresh-two", connector_id: "other-fixture" });
      const result = await insertClaim(io, { ...incoming, provenance: [one, two], events: corroboratedFacts(one, two) });
      expect(result.outcome).toBe("stored");
      if (result.outcome !== "stored") throw new Error("expected fresh evidence");
      expect(resolveConflict(result.claim, { ...first, status: "purged" })).toEqual({ action: "supersede", winner: "incoming", rule: "R6" });
      expect(getClaim(db, first.claim_id)?.status).toBe("purged");
      expect(getClaim(db, other.claim_id)?.status).toBe("purged");
      expect(result.superseded).toEqual([]);
      expect(listSupersessions(db)).toEqual([]);
    } finally { db.close(); }
  });
});
