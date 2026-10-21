import { expect, test } from "bun:test";
import { ErasurePendingError } from "../../src/canon/positive-authority";
import { correct } from "../../src/correction/correct";
import { canonFixture, putEvent, storeClaim } from "../canon/helpers";

function stage(db: ReturnType<typeof canonFixture>["db"]) {
  db.query("INSERT INTO canon_source_erasure_intents(page_path,source_key,intent,digest) VALUES (?,?,?,?)").run("unrelated-private-page", "unrelated-source", "{}", "private-digest");
}
function counts(db: ReturnType<typeof canonFixture>["db"]) {
  return ["events", "native_owner_evidence", "claims", "canon_receipts", "claim_supersessions"].map(table => db.query(`SELECT count(*) n FROM ${table}`).get());
}

test("ordinary owner correction fences before its native capture and retains the typed error", async () => {
  const f = canonFixture(); try {
    const claim = await storeClaim(f.db, putEvent(f.db)); stage(f.db);
    const before = counts(f.db);
    await expect(correct(f.io, { statement: "Grace works at Northwind.", target: { claim_id: claim.claim_id } })).rejects.toBeInstanceOf(ErasurePendingError);
    expect(counts(f.db)).toEqual(before);
  } finally { f.dispose(); }
});

test("ordinary exact correction replay precedes the positive authority fence", async () => {
  const f = canonFixture(); try {
    const claim = await storeClaim(f.db, putEvent(f.db));
    const input = { statement: "Grace works at Northwind.", target: { claim_id: claim.claim_id } };
    const first = await correct(f.io, input);
    stage(f.db); const before = counts(f.db);
    const replay = await correct(f.io, input);
    expect(replay.event_id).toBe(first.event_id);
    expect(replay.claim_ids).toEqual(first.claim_ids);
    expect(counts(f.db)).toEqual(before);
  } finally { f.dispose(); }
});
