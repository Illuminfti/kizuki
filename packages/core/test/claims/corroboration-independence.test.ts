import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { insertClaim, type InsertClaimResult } from "../../src/claims/store";
import { claimInput, claimsDb, eventFacts, putEvent } from "./helpers";

// Real ledger and vault work; bound it for a loaded host.
setDefaultTimeout(30_000);

let restatement = 0;

/** The observation must have deduped onto the first claim; anything else would make the counts below vacuous. */
function duplicate(result: InsertClaimResult) {
  if (result.outcome !== "duplicate") throw new Error(`expected a duplicate, got ${result.outcome}`);
  return result.claim;
}

/** Each observation words the same fact differently, so it reaches structural matching rather than exact replay. */
async function observe(db: ReturnType<typeof claimsDb>, eventId: string, connector = "fixture") {
  restatement += 1;
  return insertClaim({ db }, claimInput(eventId, {
    body: `Employment note ${restatement}: Grace is based at Acme.`,
    object: "Acme",
    events: [eventFacts(eventId, { connector_id: connector })],
  }));
}

describe("corroboration counts independent sources only", () => {
  test("a new revision of the same source record confirms nothing", async () => {
    const db = claimsDb();
    const first = await observe(db, putEvent(db, { source_record_id: "page-1", text: "Grace runs partnerships at Acme. Draft 1." }));
    expect(first.outcome).toBe("stored");
    // Same connector and source record, different bytes: a re-sync, not a second witness.
    const resync = await observe(db, putEvent(db, { source_record_id: "page-1", text: "Grace runs partnerships at Acme. Draft 2." }));
    expect(duplicate(resync).corroboration).toBe(1);
    const again = duplicate(await observe(db, putEvent(db, { source_record_id: "page-1", text: "Grace runs partnerships at Acme. Draft 3." })));
    expect(again.corroboration).toBe(1);
    // The revisions stay cited, so evidence and undo still see them.
    expect(again.provenance).toHaveLength(3);
  });

  test("a different source record or connector is a new independent source", async () => {
    const db = claimsDb();
    const first = await observe(db, putEvent(db, { source_record_id: "page-1" }));
    if (first.outcome !== "stored") throw new Error("first claim not stored");
    const otherRecord = await observe(db, putEvent(db, { source_record_id: "page-2" }));
    expect(duplicate(otherRecord).corroboration).toBe(2);
    const otherConnector = await observe(db, putEvent(db, { source_record_id: "page-1", connector_id: "fixture.other" }), "fixture.other");
    expect(duplicate(otherConnector).corroboration).toBe(3);
    // The old revision of an already counted record adds nothing more.
    const stale = await observe(db, putEvent(db, { source_record_id: "page-2", text: "Grace runs partnerships at Acme. Edited." }));
    expect(duplicate(stale).corroboration).toBe(3);
  });
});
