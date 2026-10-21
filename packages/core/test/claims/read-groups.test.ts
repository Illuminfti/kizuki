import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { claimKey } from "../../src/claims/hash";
import { listLiveConflicts } from "../../src/claims/identity";
import { insertClaim } from "../../src/claims/store";
import { claimInput, claimsDb, putEvent } from "./helpers";

async function member(db: Database, event: string, subject: string, object: string, at: string): Promise<void> {
  await insertClaim({ db, now: () => at }, claimInput(event, {
    subject, subjects: [subject], predicate: "employment.role", object,
    body: `${subject} has role ${object}.`, valid_from: "2026-01-01T00:00:00Z",
  }));
}

test("newest conflict keys compare nanoseconds only within their newest second", async () => {
  const db = claimsDb();
  try {
    const event = putEvent(db);
    await member(db, event, "person:older", "Earlier", "2026-01-01T00:00:00.999999999Z");
    await member(db, event, "person:older", "Later", "2026-01-01T00:00:01.000000001Z");
    await member(db, event, "person:newer", "Earlier", "2026-01-01T00:00:00.000000001Z");
    await member(db, event, "person:newer", "Later", "2026-01-01T00:00:01.000000002Z");
    expect(listLiveConflicts(db, { limit: 1 })[0]?.claim_key).toBe(claimKey("person:newer", "employment.role"));
  } finally { db.close(); }
});
