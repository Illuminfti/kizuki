import { describe, expect, test } from "bun:test";
import {
  StagingError,
  fileProposal,
  getProposal,
  hashBody,
  isSuppressed,
  listProposals,
  setProposalStatus,
} from "../../src/staging/proposals";
import { memoryDb, proposalInput } from "./helpers";

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

describe("rejection suppression", () => {
  test("content the owner rejected cannot be refiled", () => {
    const db = memoryDb();
    const stored = fileProposal(db, proposalInput());
    expect(stored.outcome).toBe("stored");
    if (stored.outcome !== "stored") return;

    setProposalStatus(db, stored.proposal.proposal_id, "rejected", "not true");
    expect(isSuppressed(db, stored.proposal.body_hash)).toBe(true);

    const refiled = fileProposal(db, proposalInput());
    expect(refiled.outcome).toBe("suppressed");
    if (refiled.outcome !== "suppressed") return;
    expect(refiled.reason).toBe("not true");
    expect(refiled.body_hash).toBe(stored.proposal.body_hash);
    expect(listProposals(db)).toHaveLength(1);
  });

  test("suppression follows the body across producers, kinds, and targets", () => {
    const db = memoryDb();
    const stored = fileProposal(db, proposalInput());
    if (stored.outcome !== "stored") throw new Error("expected stored");
    setProposalStatus(db, stored.proposal.proposal_id, "rejected", "no");

    const elsewhere = fileProposal(
      db,
      proposalInput({
        kind: "entity",
        target: "person:bob",
        producer: "agent:scribe",
      }),
    );
    expect(elsewhere.outcome).toBe("suppressed");
  });

  test("a different body is unaffected by the rejection", () => {
    const db = memoryDb();
    const stored = fileProposal(db, proposalInput());
    if (stored.outcome !== "stored") throw new Error("expected stored");
    setProposalStatus(db, stored.proposal.proposal_id, "rejected", "no");

    expect(fileProposal(db, proposalInput({ body: "other" })).outcome).toBe(
      "stored",
    );
  });

  test("rejecting without a reason is refused", () => {
    const db = memoryDb();
    const stored = fileProposal(db, proposalInput());
    if (stored.outcome !== "stored") throw new Error("expected stored");
    expect(() =>
      setProposalStatus(db, stored.proposal.proposal_id, "rejected"),
    ).toThrow(StagingError);
    expect(getProposal(db, stored.proposal.proposal_id)?.status).toBe(
      "pending",
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
    expect(() => setProposalStatus(db, "nope", "promoted")).toThrow(
      StagingError,
    );
    const stored = fileProposal(db, proposalInput());
    if (stored.outcome !== "stored") throw new Error("expected stored");
    expect(() =>
      setProposalStatus(
        db,
        stored.proposal.proposal_id,
        "accepted" as unknown as "promoted",
      ),
    ).toThrow(StagingError);
  });
});
