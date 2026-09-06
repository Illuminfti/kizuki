import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initClaims } from "../../src/claims/schema";
import { insertClaim } from "../../src/claims/store";
import { claimInput, claimsDb, FIXED_NOW, putEvent } from "./helpers";

function schemaVersion(db: Database): number {
  const statement = db.prepare<{ schema_version: number }, []>("PRAGMA schema_version");
  try { return statement.get()!.schema_version; }
  finally { statement.finalize(); }
}

test("native claims keep initialization read-only and preserve direct-claim deduplication", async () => {
  const db = claimsDb();
  try {
    const event = putEvent(db);
    const input = claimInput(event);
    const io = { db, now: () => FIXED_NOW };
    const first = await insertClaim(io, input);
    expect(first.outcome).toBe("stored");
    if (first.outcome !== "stored") throw new Error("expected native claim");
    expect(db.query("SELECT content_hash FROM claims WHERE claim_id = ?").get(first.claim.claim_id))
      .toEqual({ content_hash: "" });
    expect(db.query("SELECT COUNT(*) AS n FROM proposals").get()).toEqual({ n: 0 });

    const version = schemaVersion(db);
    const changes = db.query("SELECT total_changes() AS n").get();
    initClaims(db);
    expect(schemaVersion(db)).toBe(version);
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(changes);

    const second = await insertClaim(io, claimInput(event, {
      predicate: "tool.uses", object: "field notebook", body: "Grace uses a field notebook.",
    }));
    expect(second.outcome).toBe("stored");
    expect(schemaVersion(db)).toBe(version);
    const duplicate = await insertClaim(io, input);
    expect(duplicate.outcome).toBe("duplicate");
    if (duplicate.outcome !== "duplicate") throw new Error("expected duplicate");
    expect(duplicate.claim.claim_id).toBe(first.claim.claim_id);
    expect(schemaVersion(db)).toBe(version);
  } finally { db.close(); }
});
