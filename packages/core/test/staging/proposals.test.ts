import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyClaimsV3,
  applyLegacyStagingIdempotency,
  initClaims,
} from "../../src/claims/schema";
import { getClaim } from "../../src/claims/store";
import {
  StagingError,
  fileProposal,
  getProposal,
  hashBody,
  listProposals,
  setProposalStatus,
} from "../../src/staging/proposals";
import { event, memoryDb, proposalInput, seedEvent } from "./helpers";

describe("fileProposal", () => {
  test("stores a pending proposal with its body hash", () => {
    const db = memoryDb();
    const result = fileProposal(db, proposalInput());
    expect(result.outcome).toBe("stored");
    if (result.outcome !== "stored") return;

    expect(result.proposal.status).toBe("pending");
    expect(result.proposal.body_hash).toBe(hashBody("a staged body"));
    expect(result.proposal.provenance).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    expect(getProposal(db, result.proposal.proposal_id)).toEqual(
      result.proposal,
    );
    expect(getClaim(db, result.proposal.proposal_id)?.status).toBe("live");
  });

  test("ingest leftovers become a live claim, not a skipped queue row", () => {
    const db = memoryDb();
    const result = fileProposal(db, proposalInput());
    if (result.outcome !== "stored") throw new Error("expected stored");
    const claim = getClaim(db, result.proposal.proposal_id);
    expect(claim?.status).toBe("live");
    expect(claim?.receipt_id).toBeNull();
  });

  test("refiling identical content is a duplicate, not a second row", () => {
    const db = memoryDb();
    const first = fileProposal(db, proposalInput());
    const second = fileProposal(db, proposalInput());

    expect(first.outcome).toBe("stored");
    expect(second.outcome).toBe("duplicate");
    if (first.outcome !== "stored" || second.outcome !== "duplicate") return;
    expect(second.proposal.proposal_id).toBe(first.proposal.proposal_id);
    expect(listProposals(db)).toHaveLength(1);
  });

  test("an unchanged refile does not rewrite last_confirmed_at", () => {
    const db = memoryDb();
    const first = fileProposal(db, proposalInput());
    if (first.outcome !== "stored") throw new Error("expected stored");
    const before = getClaim(db, first.proposal.proposal_id);
    expect(before?.last_confirmed_at).toBe(before?.created_at);
    const again = fileProposal(db, proposalInput());
    expect(again.outcome).toBe("duplicate");
    const after = getClaim(db, first.proposal.proposal_id);
    expect(after?.last_confirmed_at).toBe(before?.last_confirmed_at);
    expect(after?.corroboration).toBe(1);
  });

  test("a drifted pending signature does not occupy the live claim slot", () => {
    const db = memoryDb();
    const first = fileProposal(db, proposalInput({ body: "current retraction" }));
    if (first.outcome !== "stored") throw new Error("expected stored");
    const legacy = "legacy path-only deletion";
    db.query("UPDATE proposals SET body = ?, body_hash = ? WHERE proposal_id = ?").run(
      legacy,
      hashBody(legacy),
      first.proposal.proposal_id,
    );
    db.query("UPDATE claims SET body = ?, body_hash = ? WHERE claim_id = ?").run(
      legacy,
      hashBody(legacy),
      first.proposal.proposal_id,
    );
    const current = fileProposal(db, proposalInput({ body: "current retraction" }));
    expect(current.outcome).toBe("stored");
    if (current.outcome !== "stored") return;
    expect(current.proposal.proposal_id).not.toBe(first.proposal.proposal_id);
    expect(getClaim(db, current.proposal.proposal_id)?.status).toBe("live");
    expect(getClaim(db, first.proposal.proposal_id)?.status).toBe("live");
  });

  test("dedupe is keyed by kind, target, and body hash together", () => {
    const db = memoryDb();
    fileProposal(db, proposalInput({ target: "person:ada" }));
    const otherTarget = fileProposal(
      db,
      proposalInput({ target: "person:bob" }),
    );
    const otherKind = fileProposal(
      db,
      proposalInput({ target: "person:ada", kind: "entity" }),
    );
    const otherBody = fileProposal(
      db,
      proposalInput({ target: "person:ada", body: "different" }),
    );

    expect(otherTarget.outcome).toBe("stored");
    expect(otherKind.outcome).toBe("stored");
    expect(otherBody.outcome).toBe("stored");
    expect(listProposals(db)).toHaveLength(4);
  });

  test("a null target still dedupes against another null target", () => {
    const db = memoryDb();
    fileProposal(db, proposalInput({ target: null }));
    expect(fileProposal(db, proposalInput()).outcome).toBe("duplicate");
  });

  test("rejects empty provenance", () => {
    const db = memoryDb();
    expect(() => fileProposal(db, proposalInput({ provenance: [] }))).toThrow(
      StagingError,
    );
  });

  test("rejects an unknown producer and an out-of-range confidence", () => {
    const db = memoryDb();
    expect(() =>
      fileProposal(
        db,
        proposalInput({ producer: "human" as unknown as "llm" }),
      ),
    ).toThrow(StagingError);
    expect(() => fileProposal(db, proposalInput({ confidence: 1.5 }))).toThrow(
      StagingError,
    );
  });
});

describe("listProposals", () => {
  test("filters by status and kind", () => {
    const db = memoryDb();
    const a = fileProposal(db, proposalInput({ body: "one" }));
    fileProposal(db, proposalInput({ body: "two", kind: "entity" }));
    if (a.outcome !== "stored") throw new Error("expected stored");
    setProposalStatus(db, a.proposal.proposal_id, "withdrawn");

    expect(listProposals(db, { status: "pending" })).toHaveLength(1);
    expect(listProposals(db, { status: "withdrawn" })).toHaveLength(1);
    expect(listProposals(db, { kind: "entity" })).toHaveLength(1);
    expect(listProposals(db, { limit: 1 })).toHaveLength(1);
  });
});

describe("setProposalStatus", () => {
  test("refuses an unknown proposal and an unknown status", () => {
    const db = memoryDb();
    expect(() => setProposalStatus(db, "nope", "withdrawn")).toThrow(
      StagingError,
    );
    const stored = fileProposal(db, proposalInput());
    if (stored.outcome !== "stored") throw new Error("expected stored");
    expect(() =>
      setProposalStatus(
        db,
        stored.proposal.proposal_id,
        "accepted" as unknown as "withdrawn",
      ),
    ).toThrow(StagingError);
  });

  test("refuses promote, reject, and transitions off a terminal row", () => {
    const db = memoryDb();
    const stored = fileProposal(db, proposalInput());
    if (stored.outcome !== "stored") throw new Error("expected stored");
    expect(() =>
      setProposalStatus(db, stored.proposal.proposal_id, "promoted"),
    ).toThrow(/receipt-driven/);
    expect(() =>
      setProposalStatus(db, stored.proposal.proposal_id, "rejected", "no"),
    ).toThrow(/receipt-driven/);
    setProposalStatus(db, stored.proposal.proposal_id, "withdrawn");
    expect(() =>
      setProposalStatus(db, stored.proposal.proposal_id, "withdrawn"),
    ).toThrow(/cannot withdraw a withdrawn/);
  });
});

describe("legacy staging p1 holes", () => {
  test("same body with different frontmatter or subjects is a new row", () => {
    const db = memoryDb();
    const first = fileProposal(db, proposalInput());
    const frontmatter = fileProposal(
      db,
      proposalInput({ frontmatter: { type: "fact", title: "other" } }),
    );
    const subjects = fileProposal(db, proposalInput({ subjects: ["person:grace"] }));
    expect(first.outcome).toBe("stored");
    expect(frontmatter.outcome).toBe("stored");
    expect(subjects.outcome).toBe("stored");
    if (
      first.outcome !== "stored" ||
      frontmatter.outcome !== "stored" ||
      subjects.outcome !== "stored"
    ) {
      return;
    }
    expect(listProposals(db)).toHaveLength(3);
    expect(getClaim(db, first.proposal.proposal_id)?.status).toBe("live");
    expect(getClaim(db, frontmatter.proposal.proposal_id)?.status).toBe("live");
    expect(getClaim(db, subjects.proposal.proposal_id)?.status).toBe("live");
  });

  test("new provenance corroborates a pending row instead of discarding it", () => {
    const db = memoryDb();
    const later = event({
      event_id: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
      source_record_id: "rec-later",
    });
    seedEvent(db, later);
    const first = fileProposal(db, proposalInput());
    const second = fileProposal(
      db,
      proposalInput({ provenance: [later.event_id] }),
    );
    expect(first.outcome).toBe("stored");
    expect(second.outcome).toBe("duplicate");
    if (first.outcome !== "stored" || second.outcome !== "duplicate") return;
    expect(second.proposal.proposal_id).toBe(first.proposal.proposal_id);
    expect(second.proposal.provenance).toEqual([
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      later.event_id,
    ]);
    expect(getClaim(db, first.proposal.proposal_id)?.corroboration).toBe(2);
  });

  test("a withdrawn row does not block the same evidence later", () => {
    const db = memoryDb();
    const first = fileProposal(db, proposalInput());
    if (first.outcome !== "stored") throw new Error("expected stored");
    setProposalStatus(db, first.proposal.proposal_id, "withdrawn");
    const again = fileProposal(db, proposalInput());
    expect(again.outcome).toBe("stored");
    if (again.outcome !== "stored") return;
    expect(again.proposal.proposal_id).not.toBe(first.proposal.proposal_id);
    expect(again.proposal.status).toBe("pending");
    expect(getClaim(db, again.proposal.proposal_id)?.status).toBe("live");
  });

  test("rejects a non-string target, unknown frontmatter, and missing events", () => {
    const db = memoryDb();
    expect(() =>
      fileProposal(
        db,
        proposalInput({ target: 12 as unknown as string }),
      ),
    ).toThrow(/target/);
    expect(() =>
      fileProposal(
        db,
        proposalInput({ frontmatter: { type: "fact", title: "x", secret: true } }),
      ),
    ).toThrow(/x-/);
    expect(() =>
      fileProposal(
        db,
        proposalInput({ provenance: ["01ARZ3NDEKTSV4RRFFQ69G5FFF"] }),
      ),
    ).toThrow(/do not resolve/);
  });

  test("a promoted row still takes later provenance", () => {
    const db = memoryDb();
    const later = event({
      event_id: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
      source_record_id: "rec-later",
    });
    seedEvent(db, later);
    const first = fileProposal(db, proposalInput());
    if (first.outcome !== "stored") throw new Error("expected stored");
    db.query("UPDATE proposals SET status = 'promoted' WHERE proposal_id = ?").run(
      first.proposal.proposal_id,
    );
    const second = fileProposal(
      db,
      proposalInput({ provenance: [later.event_id] }),
    );
    expect(second.outcome).toBe("duplicate");
    if (second.outcome !== "duplicate") return;
    expect(second.proposal.proposal_id).toBe(first.proposal.proposal_id);
    expect(listProposals(db)).toHaveLength(1);
    expect(second.proposal.provenance).toEqual([
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      later.event_id,
    ]);
    expect(getClaim(db, first.proposal.proposal_id)?.corroboration).toBe(2);
  });

  test("remigration collapse keeps one pending occupant with a live claim", () => {
    const db = memoryDb();
    const first = fileProposal(
      db,
      proposalInput({
        frontmatter: { type: "fact", title: "Ada", "x-display-name": "Ada" },
      }),
    );
    if (first.outcome !== "stored") throw new Error("expected stored");
    const cloneId = "01ARZ3NDEKTSV4RRFFQ69G5CLN";
    const staleHash = "a".repeat(64);
    db.exec("DROP INDEX IF EXISTS proposals_signature");
    db.exec("DROP INDEX IF EXISTS claims_signature_idempotency");
    db.query(
      `INSERT INTO proposals (
         proposal_id, kind, target, body, frontmatter, provenance, subjects,
         producer, confidence, status, created_at, body_hash, content_hash
       )
       SELECT ?, kind, target, body, frontmatter, provenance, subjects,
              producer, confidence, status, ?, body_hash, ?
         FROM proposals WHERE proposal_id = ?`,
    ).run(cloneId, "2099-01-01T00:00:00Z", staleHash, first.proposal.proposal_id);
    db.query(
      `INSERT INTO claims (
         claim_id, kind, target, body, frontmatter, provenance, subjects,
         producer, confidence, status, created_at, body_hash, content_hash,
         subject, predicate, object, polarity, claim_key, authority,
         sensitivity, taint, model_ref, valid_from, valid_to, asserted_at,
         retracted_at, superseded_by, receipt_id, corroboration, last_confirmed_at
       )
       SELECT ?, kind, target, body, frontmatter, provenance, subjects,
              producer, confidence, status, created_at, body_hash, ?,
              subject, predicate, object, polarity, claim_key, authority,
              sensitivity, taint, model_ref, valid_from, valid_to, asserted_at,
              retracted_at, superseded_by, receipt_id, corroboration, last_confirmed_at
         FROM claims WHERE claim_id = ?`,
    ).run(cloneId, staleHash, first.proposal.proposal_id);
    db.query("DELETE FROM claims WHERE claim_id = ?").run(first.proposal.proposal_id);
    db.query(
      `INSERT INTO claims (
         claim_id, kind, target, body, frontmatter, provenance, subjects,
         producer, confidence, status, created_at, body_hash, content_hash,
         subject, predicate, object, polarity, claim_key, authority,
         sensitivity, taint, model_ref, valid_from, valid_to, asserted_at,
         retracted_at, superseded_by, receipt_id, corroboration, last_confirmed_at
       )
       SELECT ?, kind, target, body, frontmatter, provenance, subjects,
              producer, confidence, status, created_at, body_hash, ?,
              subject, predicate, object, polarity, claim_key, authority,
              sensitivity, taint, model_ref, valid_from, valid_to, asserted_at,
              retracted_at, superseded_by, receipt_id, corroboration, last_confirmed_at
         FROM claims WHERE claim_id = ?`,
    ).run(first.proposal.proposal_id, first.proposal.content_hash, cloneId);
    db.exec(
      `CREATE UNIQUE INDEX proposals_signature
         ON proposals (content_hash) WHERE status = 'pending'`,
    );
    db.exec(
      `CREATE UNIQUE INDEX claims_signature_idempotency
         ON claims (content_hash)
         WHERE status = 'live' AND kind <> 'purge_review' AND content_hash <> ''`,
    );
    expect(() => applyLegacyStagingIdempotency(db)).not.toThrow();
    expect(listProposals(db, { status: "pending" })).toHaveLength(1);
    expect(getProposal(db, cloneId)?.status).toBe("withdrawn");
    expect(getClaim(db, cloneId)?.status).toBe("skipped");
    const again = fileProposal(
      db,
      proposalInput({
        frontmatter: { type: "fact", title: "Ada", "x-display-name": "Ada" },
      }),
    );
    expect(again.outcome).toBe("duplicate");
    if (again.outcome !== "duplicate") return;
    expect(again.proposal.proposal_id).toBe(first.proposal.proposal_id);
    expect(getClaim(db, first.proposal.proposal_id)?.status).toBe("live");
  });

  test("v3 remigration keeps split claim uniqueness", () => {
    const db = memoryDb();
    const first = fileProposal(db, proposalInput());
    const other = fileProposal(
      db,
      proposalInput({ frontmatter: { type: "fact", title: "other" } }),
    );
    expect(first.outcome).toBe("stored");
    expect(other.outcome).toBe("stored");
    if (first.outcome !== "stored" || other.outcome !== "stored") return;
    expect(() => applyClaimsV3(db)).not.toThrow();
    expect(getClaim(db, first.proposal.proposal_id)?.status).toBe("live");
    expect(getClaim(db, other.proposal.proposal_id)?.status).toBe("live");
    const claimsSql =
      db
        .query<{ sql: string | null }, [string]>(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get("claims_idempotency")?.sql ?? "";
    expect(claimsSql).toContain("content_hash");
    db.exec("DROP TABLE identity_links");
    expect(() => initClaims(db)).not.toThrow();
    expect(getClaim(db, first.proposal.proposal_id)?.status).toBe("live");
    expect(getClaim(db, other.proposal.proposal_id)?.status).toBe("live");
  });

  test("an upgraded empty signature still occupies the live slot", () => {
    const db = memoryDb();
    const first = fileProposal(db, proposalInput());
    if (first.outcome !== "stored") throw new Error("expected stored");
    db.query("UPDATE proposals SET content_hash = ''").run();
    db.query("UPDATE claims SET content_hash = ''").run();
    db.exec("DROP INDEX IF EXISTS proposals_signature");
    db.exec("DROP INDEX IF EXISTS claims_signature_idempotency");
    db.exec("DROP INDEX IF EXISTS claims_idempotency");
    applyLegacyStagingIdempotency(db);
    const again = fileProposal(db, proposalInput());
    expect(again.outcome).toBe("duplicate");
    if (again.outcome !== "duplicate") return;
    expect(again.proposal.proposal_id).toBe(first.proposal.proposal_id);
    expect(listProposals(db)).toHaveLength(1);
    expect(getClaim(db, first.proposal.proposal_id)?.status).toBe("live");
    expect(again.proposal.content_hash).toBe(first.proposal.content_hash);
    expect(
      db
        .query<{ content_hash: string }, [string]>(
          "SELECT content_hash FROM claims WHERE claim_id = ?",
        )
        .get(first.proposal.proposal_id)?.content_hash,
    ).toBe(first.proposal.content_hash);
  });

  test("initClaims heals empty live signatures while the unique indexes remain", () => {
    const db = memoryDb();
    const first = fileProposal(db, proposalInput());
    if (first.outcome !== "stored") throw new Error("expected stored");
    db.query("UPDATE proposals SET content_hash = ''").run();
    db.query("UPDATE claims SET content_hash = ''").run();
    expect(() => initClaims(db)).not.toThrow();
    const again = fileProposal(db, proposalInput());
    expect(again.outcome).toBe("duplicate");
    if (again.outcome !== "duplicate") return;
    expect(again.proposal.proposal_id).toBe(first.proposal.proposal_id);
    expect(again.proposal.content_hash).toBe(first.proposal.content_hash);
    expect(
      db
        .query<{ content_hash: string }, [string]>(
          "SELECT content_hash FROM claims WHERE claim_id = ?",
        )
        .get(first.proposal.proposal_id)?.content_hash,
    ).toBe(first.proposal.content_hash);
  });

  test.each(["pending", "withdrawn"])("initClaims repairs a claim signature from its %s proposal", (status) => {
    const db = memoryDb();
    try {
      const first = fileProposal(db, proposalInput());
      if (first.outcome !== "stored") throw new Error("expected stored");
      db.query("UPDATE claims SET content_hash = ''").run();
      // Keep every index. Pending isolates the claim-side readiness check;
      // withdrawn preserves repair of historical projection inconsistencies.
      db.query("UPDATE proposals SET status = ?, content_hash = ?").run(
        status, status === "pending" ? first.proposal.content_hash : "",
      );
      initClaims(db);
      expect(db.query("SELECT content_hash FROM claims WHERE claim_id = ?").get(first.proposal.proposal_id))
        .toEqual({ content_hash: first.proposal.content_hash });
      expect(getClaim(db, first.proposal.proposal_id)?.status).toBe("live");
    } finally { db.close(); }
  });

  test("a later sighting may raise the stored sensitivity floor", () => {
    const db = memoryDb();
    const first = fileProposal(db, proposalInput());
    if (first.outcome !== "stored") throw new Error("expected stored");
    db.query("UPDATE claims SET sensitivity = 'public' WHERE claim_id = ?").run(
      first.proposal.proposal_id,
    );
    const raised = fileProposal(db, proposalInput());
    expect(raised.outcome).toBe("duplicate");
    if (raised.outcome !== "duplicate") return;
    expect(raised.proposal.proposal_id).toBe(first.proposal.proposal_id);
    expect(listProposals(db)).toHaveLength(1);
    expect(getClaim(db, first.proposal.proposal_id)?.sensitivity).toBe("private");
  });

  test("fileProposal has no public suppression bypass", () => {
    expect(fileProposal.length).toBe(3);
    const source = readFileSync(
      join(import.meta.dir, "../../src/staging/proposals.ts"),
      "utf8",
    );
    expect(source).not.toContain("bypassSuppression");
  });
});
