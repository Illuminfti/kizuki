import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_AGENT_GRANT } from "../../src/agents";
import { getClaim, insertClaim, listClaims, pendingRetrievalOps, prepareClaimInsert, retryRetrievalOps } from "../../src/claims/store";
import { openLedger, LEDGER_SCHEMA_VERSION } from "../../src/ledger/db";
import { claimReader } from "../../src/serving/claims";
import { claimInput, FixtureVectorPort, putEvent } from "./helpers";

const indexSql = (db: Database) => db.query<{ sql: string }, []>(
  "SELECT sql FROM sqlite_master WHERE name='claims_idempotency'",
).get()!.sql;

test("fresh and previous-schema databases support scoped exact twins without losing stored claims", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scoped-claims-"));
  const path = join(directory, "ledger.sqlite");
  let db = openLedger(path);
  try {
    expect(indexSql(db)).not.toContain("UNIQUE");
    const hidden = await insertClaim({ db }, claimInput(putEvent(db), {
      target: "facts:employment", sensitivity: "private",
    }));
    if (hidden.outcome !== "stored") throw new Error(hidden.outcome);
    const original = getClaim(db, hidden.claim.claim_id);
    // Reconstruct the previous version's index, then reopen through migration.
    db.exec("DROP INDEX claims_idempotency; CREATE UNIQUE INDEX claims_idempotency ON claims(kind,coalesce(target,''),body_hash) WHERE status='live' AND kind<>'purge_review' AND (content_hash IS NULL OR content_hash='') AND is_world_typed=0");
    db.query("UPDATE schema_version SET version=?").run(LEDGER_SCHEMA_VERSION - 1);
    db.close();
    db = openLedger(path);
    expect(db.query<{ version: number }, []>("SELECT version FROM schema_version").get()?.version).toBe(LEDGER_SCHEMA_VERSION);
    expect(indexSql(db)).not.toContain("UNIQUE");
    expect(getClaim(db, hidden.claim.claim_id)).toEqual(original);
    const visibility = claimReader(db, { ...OWNER_AGENT_GRANT, ceiling: "personal" }, { owner: false, purpose: "recall" }).visibility;
    const input = claimInput(putEvent(db), { target: "facts:employment", sensitivity: "public" });
    const incoming = await insertClaim({ db, visibility }, input);
    expect(incoming.outcome).toBe("stored");
    expect(listClaims(db)).toHaveLength(2);
    expect((await insertClaim({ db, visibility }, input)).outcome).toBe("duplicate");
    db.close();
    db = openLedger(path);
    expect(listClaims(db)).toHaveLength(2);
    expect(getClaim(db, hidden.claim.claim_id)).toEqual(original);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("scoped filing rolls back without changing hidden support and serializes prepared retries", async () => {
  const db = openLedger(":memory:");
  try {
    const hidden = await insertClaim({ db }, claimInput(putEvent(db), { sensitivity: "private" }));
    if (hidden.outcome !== "stored") throw new Error(hidden.outcome);
    const original = getClaim(db, hidden.claim.claim_id);
    const visibility = claimReader(db, { ...OWNER_AGENT_GRANT, ceiling: "personal" }, { owner: false, purpose: "recall" }).visibility;
    const input = claimInput(putEvent(db), { sensitivity: "public" });
    const first = await prepareClaimInsert({ db, visibility }, input);
    const second = await prepareClaimInsert({ db, visibility }, input);
    expect(() => db.transaction(() => { first.apply(); throw new Error("synthetic interruption"); }).immediate()).toThrow("synthetic interruption");
    expect(listClaims(db)).toHaveLength(1);
    const stored = db.transaction(() => first.apply()).immediate();
    const replay = db.transaction(() => second.apply()).immediate();
    expect(stored.outcome).toBe("stored");
    expect(replay.outcome).toBe("duplicate");
    expect(listClaims(db)).toHaveLength(2);
    expect(getClaim(db, hidden.claim.claim_id)).toEqual(original);
  } finally { db.close(); }
});

test("scoped index publication retries readable work without touching or counting hidden pending work", async () => {
  const db = openLedger(":memory:");
  const retrieval = new FixtureVectorPort();
  const upsert = retrieval.upsert.bind(retrieval);
  try {
    retrieval.upsert = async () => { throw new Error("synthetic index interruption"); };
    const hidden = await insertClaim({ db, retrieval }, claimInput(putEvent(db), { sensitivity: "private" }));
    if (hidden.outcome !== "stored") throw new Error(hidden.outcome);
    const written: string[] = [];
    retrieval.upsert = async docs => { written.push(...docs.map(doc => doc.doc_id)); return upsert(docs); };
    const visibility = claimReader(db, { ...OWNER_AGENT_GRANT, ceiling: "personal" }, { owner: false, purpose: "recall" }).visibility;
    const filed = await insertClaim({ db, retrieval, visibility }, claimInput(putEvent(db), {
      target: "facts:visible", sensitivity: "personal",
    }));
    if (filed.outcome !== "stored") throw new Error(filed.outcome);
    expect(written).toEqual([`claim:${filed.claim.claim_id}`]);
    expect(pendingRetrievalOps(db).map(op => op.doc_id)).toEqual([hidden.claim.claim_id]);
    expect(await retryRetrievalOps({ db, retrieval, visibility })).toEqual({ retried: 0, pending: 0 });
    expect(getClaim(db, hidden.claim.claim_id)?.status).toBe("live");
  } finally { db.close(); }
});
