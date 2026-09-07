import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { claimKey, hashBody } from "../../src/claims/hash";
import { applyClaimsV3 } from "../../src/claims/schema";

const BODY = "The meeting starts at noon.";
const AT = "2026-01-03T00:00:00Z";
const REASON = "The meeting time needs a correction.";

/** Ordinary v2 storage, before claims widening; no event or live vault is needed. */
function legacy(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE proposals (
      proposal_id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT,
      body TEXT NOT NULL, frontmatter TEXT NOT NULL, provenance TEXT NOT NULL,
      subjects TEXT NOT NULL, producer TEXT NOT NULL, confidence REAL NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, body_hash TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX proposals_idempotency
      ON proposals(kind, coalesce(target, ''), body_hash);
    CREATE TABLE rejections (
      body_hash TEXT NOT NULL, reason TEXT NOT NULL, proposal_id TEXT NOT NULL,
      at TEXT NOT NULL, PRIMARY KEY (body_hash, proposal_id)
    ) STRICT;
  `);
  return db;
}

function proposal(db: Database, id: string, subject: string, body = BODY): void {
  db.query(`INSERT INTO proposals VALUES
    (?, 'claim', ?, ?, '{}', '[]', ?, 'deterministic', 0.8, 'pending', ?, ?)`)
    .run(id, subject, body, JSON.stringify([subject]), AT, hashBody(body));
}

function reject(db: Database, id: string, body = BODY, reason = REASON): void {
  db.query("INSERT INTO rejections VALUES (?, ?, ?, ?)").run(hashBody(body), reason, id, AT);
}

function converted(db: Database, id: string, body = BODY) {
  const identity = new Bun.CryptoHasher("sha256")
    .update(`rejection:${hashBody(body)}:${id}`).digest("hex");
  return db.query<{
    body: string; subject: string | null; predicate: string | null;
    claim_key: string | null; status: string; authority: string;
    polarity: string; frontmatter: string;
  }, [string]>(`SELECT body, subject, predicate, claim_key, status, authority, polarity, frontmatter
    FROM claims WHERE claim_id = ?`).get(`rej-${identity}`);
}

function expectSkipped(db: Database, id: string): void {
  expect(converted(db, id)).toEqual({
    body: REASON, subject: null, predicate: null, claim_key: null,
    status: "skipped", authority: "owner_correction", polarity: "negative",
    frontmatter: JSON.stringify({ "x-rejection-reason": REASON, "x-migrated-from": "rejections" }),
  });
}

for (const order of [["alpha", "beta"], ["beta", "alpha"]]) {
  test(`rejection migration binds the exact same-body proposal (${order.join(" first, ")})`, () => {
    const db = legacy();
    try {
      for (const id of order) proposal(db, id, `person:${id}`);
      reject(db, "beta");
      applyClaimsV3(db);
      expect(converted(db, "beta")).toMatchObject({
        body: BODY, subject: "person:beta", predicate: "decision.rejected",
        claim_key: claimKey("person:beta", "decision.rejected"), status: "live",
        authority: "owner_correction", polarity: "negative",
      });
      expect(db.query("SELECT count(*) AS n FROM claims WHERE authority = 'owner_correction'").get())
        .toEqual({ n: 1 });
      const before = db.query("SELECT * FROM claims ORDER BY claim_id").all();
      applyClaimsV3(db);
      expect(db.query("SELECT * FROM claims ORDER BY claim_id").all()).toEqual(before);
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'rejections'").all()).toEqual([]);
    } finally { db.close(); }
  });
}

test("rejection migration infers a missing proposal's subject only from a unique body match", () => {
  const db = legacy();
  try {
    proposal(db, "kept", "person:kept");
    reject(db, "missing");
    applyClaimsV3(db);
    expect(converted(db, "missing")).toMatchObject({
      body: BODY, subject: "person:kept", predicate: "decision.rejected",
      claim_key: claimKey("person:kept", "decision.rejected"), status: "live",
    });
  } finally { db.close(); }
});

test("rejection migration preserves an ambiguous missing-proposal reason without choosing a subject", () => {
  const db = legacy();
  try {
    proposal(db, "alpha", "person:alpha");
    proposal(db, "beta", "person:beta");
    reject(db, "missing");
    applyClaimsV3(db);
    expectSkipped(db, "missing");
    expect(db.query("SELECT count(*) AS n FROM claims WHERE status = 'live'").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

test("rejection migration preserves an unmatched reason as an inactive compatibility record", () => {
  const db = legacy();
  try {
    reject(db, "missing");
    applyClaimsV3(db);
    expectSkipped(db, "missing");
  } finally { db.close(); }
});

test("rejection migration does not transfer a changed named proposal's rejection to another subject", () => {
  const db = legacy();
  try {
    proposal(db, "named", "person:named", "The meeting starts at one.");
    proposal(db, "other", "person:other");
    reject(db, "named");
    applyClaimsV3(db);
    expectSkipped(db, "named");
  } finally { db.close(); }
});

test("rejection migration retains every recorded version and reason for one proposal", () => {
  const db = legacy();
  try {
    const currentBody = "The meeting starts at one.";
    const currentReason = "The updated time also needs a correction.";
    proposal(db, "named", "person:named", currentBody);
    reject(db, "named");
    reject(db, "named", currentBody, currentReason);
    applyClaimsV3(db);
    expectSkipped(db, "named");
    expect(converted(db, "named", currentBody)).toMatchObject({
      body: currentBody, subject: "person:named", status: "live",
      authority: "owner_correction", predicate: "decision.rejected",
      frontmatter: JSON.stringify({
        "x-rejection-reason": currentReason, "x-migrated-from": "rejections",
      }),
    });
    const rows = db.query<{ claim_id: string }, []>(
      "SELECT claim_id FROM claims WHERE authority = 'owner_correction'",
    ).all();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.claim_id)).size).toBe(2);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'rejections'").all()).toEqual([]);
  } finally { db.close(); }
});
