import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { applyCanonWrite } from "../../src/canon/apply";
import { createBudgetTracker } from "../../src/canon/budget";
import { CanonWriteError } from "../../src/canon/errors";
import { readReceiptsLog } from "../../src/canon/receipts";
import {
  countUnwrittenLiveClaims, getClaim, insertClaim, listUnwrittenLiveClaims,
} from "../../src/claims/store";
import { fileProposal } from "../../src/staging/proposals";
import { claimInput, FixtureVectorPort } from "../claims/helpers";
import { memoryDb, proposalInput } from "../staging/helpers";
import { canonFixture, putEvent, storeClaim } from "./helpers";

test("retired purge-review admission leaves claims and retrieval unchanged", async () => {
  const fixture = canonFixture();
  try {
    const eventId = putEvent(fixture.db);
    const retrieval = new FixtureVectorPort();
    await expect(insertClaim({ db: fixture.db, retrieval }, claimInput(eventId, {
      kind: "purge_review",
    }))).rejects.toThrow("historical compatibility only");
    expect(fixture.db.query("SELECT * FROM claims").all()).toEqual([]);
    expect(fixture.db.query("SELECT * FROM retrieval_ops").all()).toEqual([]);
    expect(retrieval.docs.size).toBe(0);
  } finally { fixture.dispose(); }
});

test("retired purge-review proposal admission leaves compatibility tables unchanged", () => {
  const db = memoryDb();
  try {
    expect(() => fileProposal(db, proposalInput({ kind: "purge_review" })))
      .toThrow("historical compatibility only");
    expect(db.query("SELECT * FROM proposals").all()).toEqual([]);
    expect(db.query("SELECT * FROM claims").all()).toEqual([]);
    expect(db.query("SELECT * FROM retrieval_ops").all()).toEqual([]);
  } finally { db.close(); }
});

test("claim admission validates one captured snapshot of ordinary input", async () => {
  const fixture = canonFixture();
  try {
    const eventId = putEvent(fixture.db);
    const input = claimInput(eventId);
    let reads = 0;
    Object.defineProperty(input, "kind", { enumerable: true, get: () => {
      reads += 1;
      return "claim";
    } });
    const result = await insertClaim({ db: fixture.db }, input);
    expect(result.outcome).toBe("stored");
    expect(reads).toBe(1);
    if (result.outcome !== "stored") throw new Error("expected ordinary claim");
    expect(getClaim(fixture.db, result.claim.claim_id)?.kind).toBe("claim");
  } finally { fixture.dispose(); }
});

test("historical purge-review rows remain readable and inert before write preflight", async () => {
  const fixture = canonFixture();
  try {
    const { db, io, vault } = fixture;
    const eventId = putEvent(db);
    const original = await storeClaim(db, eventId);
    // Stored compatibility data only: new admission rejects this retired kind.
    db.query("UPDATE claims SET kind = 'purge_review' WHERE claim_id = ?").run(original.claim_id);
    const historical = getClaim(db, original.claim_id);
    if (historical === null) throw new Error("missing compatibility fixture");
    expect(historical.kind).toBe("purge_review");
    expect(countUnwrittenLiveClaims(db)).toBe(0);
    expect(listUnwrittenLiveClaims(db)).toEqual([]);

    const current = await storeClaim(db, eventId, {
      body: "Grace uses a notebook.", predicate: "tool.uses", object: "notebook",
    });
    expect(countUnwrittenLiveClaims(db)).toBe(1);
    expect(listUnwrittenLiveClaims(db, 1).map(row => row.claim_id)).toEqual([current.claim_id]);

    db.query("INSERT INTO canon_holds (page_path, proposal_id, reason, held_at) VALUES (?, ?, ?, ?)")
      .run("people/fixture.md", historical.claim_id, "compatibility fixture", historical.created_at);
    const claimsBefore = db.query("SELECT * FROM claims ORDER BY claim_id").all();
    const holdsBefore = db.query("SELECT * FROM canon_holds").all();
    const receiptsBefore = db.query("SELECT * FROM canon_receipts").all();
    const filesBefore = readdirSync(vault, { recursive: true }).sort();
    const budget = createBudgetTracker({ canon_writes_per_run: 1 });
    for (const supplied of [historical, [historical]]) {
      try {
        applyCanonWrite(io, supplied, { action: "skip", reason: "duplicate" }, { writer: "loop", budget });
        throw new Error("expected retired-kind refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(CanonWriteError);
        expect((error as CanonWriteError).code).toBe("claim_kind_retired");
      }
    }
    expect(budget.usage().canon_writes_per_run.used).toBe(0);
    expect(db.query("SELECT * FROM claims ORDER BY claim_id").all()).toEqual(claimsBefore);
    expect(db.query("SELECT * FROM canon_holds").all()).toEqual(holdsBefore);
    expect(db.query("SELECT * FROM canon_receipts").all()).toEqual(receiptsBefore);
    expect(readReceiptsLog(vault)).toEqual([]);
    expect(readdirSync(vault, { recursive: true }).sort()).toEqual(filesBefore);
  } finally { fixture.dispose(); }
});
