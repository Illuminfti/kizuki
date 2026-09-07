import { expect, test } from "bun:test";
import { insertClaim, getClaim, listSupersessions } from "../../src/claims/store";
import { validityOverlaps } from "../../src/claims/conflict";
import { listValidityGaps } from "../../src/claims/gaps";
import { claimInput, claimsDb, putEvent } from "./helpers";
import { canonFixture } from "../canon/helpers";
import { correct } from "../../src/correction/correct";

function fixture() {
  const db = claimsDb();
  const ids = [putEvent(db, { connector_id: "fixture-a" }), putEvent(db, { connector_id: "fixture-b" })];
  const file = (object: string, valid_from: string, confidence: number, valid_to: string | null = null) =>
    insertClaim({ db }, claimInput(ids[0]!, { provenance: ids, object, body: `Grace works at ${object}.`, valid_from, valid_to, confidence }));
  return { db, ids, file };
}

test("R3 keeps newer evidence when an older offset timestamp sorts later as text", async () => {
  const f = fixture();
  try {
    const first = await f.file("Acme", "2026-09-07T00:00:00Z", .6);
    const second = await f.file("Example", "2026-09-07T01:30:00+02:00", .9);
    expect(first.outcome).toBe("stored");
    expect(second.outcome).toBe("skipped");
    if (first.outcome !== "stored" || second.outcome !== "skipped") throw new Error("unexpected outcomes");
    expect(getClaim(f.db, first.claim.claim_id)?.status).toBe("live");
    expect(second.claim.valid_from).toBe("2026-09-07T01:30:00+02:00");
    expect(second.claim.provenance).toEqual(f.ids);
    expect(listSupersessions(f.db)).toEqual([]);
  } finally { f.db.close(); }
});

test("equal instants use confidence and preserve original timestamp spellings in supersession", async () => {
  const f = fixture();
  try {
    const first = await f.file("Acme", "2026-09-07T01:00:00+01:00", .6);
    const second = await f.file("Example", "2026-09-07T00:00:00.000Z", .9);
    expect(second.outcome).toBe("stored");
    if (first.outcome !== "stored" || second.outcome !== "stored") throw new Error("unexpected outcomes");
    expect(second.superseded).toEqual([{ claim_id: first.claim.claim_id, rule: "R3" }]);
    expect(getClaim(f.db, first.claim.claim_id)?.valid_from).toBe("2026-09-07T01:00:00+01:00");
    expect(getClaim(f.db, first.claim.claim_id)?.valid_to).toBe("2026-09-07T00:00:00.000Z");
    expect(second.claim.provenance).toEqual(f.ids);
  } finally { f.db.close(); }
});

test("arbitration detects overlap across offsets and preserves sub-millisecond ordering", async () => {
  expect(validityOverlaps(
    { valid_from: "2026-09-07T02:00:00+02:00", valid_to: "2026-09-07T03:00:00+02:00" },
    { valid_from: "2026-09-07T00:30:00Z", valid_to: "2026-09-07T01:30:00Z" },
  )).toBe(true);
  expect(validityOverlaps(
    { valid_from: "2026-09-07T00:00:00Z", valid_to: "2026-09-07T01:00:00+01:00" },
    { valid_from: "2026-09-07T00:00:00.000Z", valid_to: null },
  )).toBe(false);
  const f = fixture();
  try {
    await f.file("Acme", "2026-09-07T01:00:00.0001+01:00", .6);
    const newer = await f.file("Example", "2026-09-07T00:00:00.0002Z", .9);
    expect(newer.outcome).toBe("stored");
    if (newer.outcome !== "stored") throw new Error("unexpected outcome");
    expect(newer.superseded).toHaveLength(1);
  } finally { f.db.close(); }
});

for (const end of ["2026-09-07T01:30:00+02:00", "2026-09-07T01:00:00+01:00"]) {
  test(`invalid incoming interval ending ${end} fails before durable effects`, async () => {
    const f = fixture();
    try {
      const before = f.db.query("SELECT total_changes() AS n").get();
      await expect(f.file("Acme", "2026-09-07T00:00:00Z", .8, end)).rejects.toThrow("valid_to must be after valid_from");
      expect(f.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 0 });
      expect(listSupersessions(f.db)).toEqual([]);
      expect(f.db.query("SELECT total_changes() AS n").get()).toEqual(before);
    } finally { f.db.close(); }
  });
}

test("a defaulted valid_from is checked against valid_to before filing", async () => {
  const f = fixture();
  try {
    await expect(insertClaim({ db: f.db, now: () => "2026-09-07T00:00:00Z" }, claimInput(f.ids[0]!, {
      provenance: f.ids, valid_to: "2026-09-07T01:00:00+01:00",
    }))).rejects.toThrow("valid_to must be after valid_from");
    expect(f.db.query("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});

test("validity gaps compare instants while returning the original endpoint bytes", async () => {
  const f = fixture();
  try {
    await f.file("Acme", "2026-09-07T02:00:00+02:00", .8, "2026-09-07T03:00:00+02:00");
    await f.file("Example", "2026-09-07T01:30:00Z", .8, "2026-09-07T02:30:00Z");
    expect(listValidityGaps(f.db).map(({ after, before }) => ({ after, before }))).toEqual([
      { after: "2026-09-07T03:00:00+02:00", before: "2026-09-07T01:30:00Z" },
    ]);
  } finally { f.db.close(); }
});

test("supersession clips a finite interval at the earlier instant, not the smaller string", async () => {
  const f = fixture();
  try {
    const first = await f.file("Acme", "2026-09-07T00:00:00Z", .6, "2026-09-07T01:00:00Z");
    const second = await f.file("Example", "2026-09-07T02:30:00+02:00", .9);
    if (first.outcome !== "stored" || second.outcome !== "stored") throw new Error("unexpected outcomes");
    expect(second.superseded).toHaveLength(1);
    expect(getClaim(f.db, first.claim.claim_id)?.valid_to).toBe("2026-09-07T02:30:00+02:00");
  } finally { f.db.close(); }
});

test("empty and reversed historical intervals cannot overlap a containing live interval", () => {
  const containing = { valid_from: "2026-09-06T00:00:00Z", valid_to: "2026-09-08T00:00:00Z" };
  for (const valid_to of ["2026-09-07T01:00:00+01:00", "2026-09-07T01:30:00+02:00"]) {
    const interval = { valid_from: "2026-09-07T00:00:00Z", valid_to };
    expect(validityOverlaps(interval, containing)).toBe(false);
    expect(validityOverlaps(containing, interval)).toBe(false);
  }
});

test("correction scopes include equal instants and exclude genuinely earlier claims", async () => {
  const f = canonFixture();
  try {
    const event = putEvent(f.db);
    const stored = await insertClaim({ db: f.db }, claimInput(event, { valid_from: "2026-09-07T01:00:00+01:00" }));
    if (stored.outcome !== "stored") throw new Error("unexpected outcome");
    const input = { statement: "Grace works at Example.", target: { claim_id: stored.claim.claim_id }, dry_run: true };
    const preview = await correct(f.io, { ...input, scope: { since: "2026-09-07T00:00:00Z", until: "2026-09-07T00:00:00.000Z" } });
    expect(preview.superseded.map(row => row.claim_id)).toEqual([stored.claim.claim_id]);
    await expect(correct(f.io, { ...input, scope: { since: "2026-09-07T00:30:00Z" } })).rejects.toThrow("no live claims matched");
    expect(getClaim(f.db, stored.claim.claim_id)?.status).toBe("live");
    expect(getClaim(f.db, stored.claim.claim_id)?.valid_from).toBe("2026-09-07T01:00:00+01:00");
  } finally { f.dispose(); }
});
