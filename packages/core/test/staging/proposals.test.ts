import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(fileProposal(db, proposalInput()).outcome).toBe("stored");
    expect(
      fileProposal(db, proposalInput({ frontmatter: { type: "fact", title: "other" } }))
        .outcome,
    ).toBe("stored");
    expect(
      fileProposal(db, proposalInput({ subjects: ["person:grace"] })).outcome,
    ).toBe("stored");
    expect(listProposals(db)).toHaveLength(3);
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

  test("fileProposal has no public suppression bypass", () => {
    expect(fileProposal.length).toBe(3);
    const source = readFileSync(
      join(import.meta.dir, "../../src/staging/proposals.ts"),
      "utf8",
    );
    expect(source).not.toContain("bypassSuppression");
  });
});
