import { expect, test } from "bun:test";
import { insertClaim, listClaims } from "../../src/claims/store";
import { claimInput, claimsDb, putEvent } from "./helpers";

async function fixture() {
  const db = claimsDb(), event = putEvent(db);
  for (const [index, object] of ["Alpha", "Bravo", "Charlie", "Delta"].entries()) {
    const stored = await insertClaim({ db, now: () => new Date(Date.UTC(2026, 8, 5, 0, 0, index)).toISOString() },
      claimInput(event, { predicate: "tool.uses", object, body: `Grace uses the ${object} tool.` }));
    expect(stored.outcome).toBe("stored");
  }
  return db;
}

test("claim filtering applies before the accepted-result limit and releases its early-return cursor", async () => {
  const db = await fixture(), visited: (string | null)[] = [];
  try {
    const selected = listClaims(db, { status: "live", subject: "person:grace", keyed: true, limit: 1,
      filter: claim => { visited.push(claim.object); return claim.object !== "Alpha"; } });
    expect(selected.map(claim => claim.object)).toEqual(["Bravo"]);
    expect(visited).toEqual(["Alpha", "Bravo"]);
    expect(() => db.close(true)).not.toThrow();
  } finally { db.close(); }
});

test("claim filtering retains deterministic order, honors zero and unlimited results, and releases exhaustion", async () => {
  const db = await fixture();
  try {
    let visited = 0;
    expect(listClaims(db, { limit: 0, filter: () => { visited++; return true; } })).toEqual([]);
    expect(visited).toBe(0);
    const selected = listClaims(db, { limit: -1, filter: claim => claim.object !== "Bravo" });
    expect(selected.map(claim => claim.object)).toEqual(["Alpha", "Charlie", "Delta"]);
    expect(() => db.close(true)).not.toThrow();
  } finally { db.close(); }
});

test("a claim-filter exception propagates and releases the prepared statement", async () => {
  const db = await fixture();
  try {
    expect(() => listClaims(db, { limit: 2, filter: claim => {
      if (claim.object === "Bravo") throw new Error("synthetic predicate failure");
      return false;
    } })).toThrow("synthetic predicate failure");
    expect(() => db.close(true)).not.toThrow();
  } finally { db.close(); }
});
