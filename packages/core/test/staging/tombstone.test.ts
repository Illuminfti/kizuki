import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  CaptureEvent,
  CaptureEventInput,
} from "../../src/contracts/event";
import { accept } from "../../src/ledger/ledger";
import { openLedger } from "../../src/ledger/db";
import {
  cascadeTombstone,
  proposalsForEvent,
} from "../../src/staging/producers";
import { PromoteError, ownerPromote } from "../../src/staging/promote";
import {
  fileProposal,
  getProposal,
  initStaging,
  listProposals,
} from "../../src/staging/proposals";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { initVault } from "../../src/vault/init";
import { validEvent } from "../fixtures";
import { tempVault } from "./helpers";

function vaultDb(): Database {
  const db = openLedger(":memory:");
  initStaging(db);
  return db;
}

function stored(db: Database, input: CaptureEventInput): CaptureEvent {
  const result = accept(db, input);
  if (result.status !== "stored") {
    throw new Error(`expected stored, got ${result.status}`);
  }
  return result.event;
}

function tombstoneInput(): CaptureEventInput {
  return {
    ...validEvent(),
    text: "",
    subjects: [],
    attachments: [],
    metadata: {},
    deleted: true,
    occurred_at: "2026-03-02T00:00:00Z",
  };
}

describe("cascadeTombstone", () => {
  test("withdraws pending proposals keyed by the source record, not the tombstone id", () => {
    const db = vaultDb();
    const original = stored(db, validEvent());
    for (const input of proposalsForEvent(original)) fileProposal(db, input);
    expect(listProposals(db, { status: "pending" })).toHaveLength(2);

    const tombstone = stored(db, tombstoneInput());
    // Proposals cite the original event id; the tombstone's id is fresh.
    expect(tombstone.event_id).not.toBe(original.event_id);

    const cascade = cascadeTombstone(db, tombstone);
    expect(cascade.withdrawn).toHaveLength(2);
    expect(cascade.retractions_filed).toHaveLength(0);
    expect(listProposals(db, { status: "pending" })).toHaveLength(0);
    expect(listProposals(db, { status: "withdrawn" })).toHaveLength(2);
    db.close();
  });

  test("files a deletion proposal for a promoted page; promoting it archives the page", () => {
    const db = vaultDb();
    const vault = tempVault();
    try {
      initVault(vault.path);
      const original = stored(db, validEvent());
      const capture = proposalsForEvent(original).find(
        (input) => input.kind === "claim",
      );
      if (capture === undefined) throw new Error("no capture note produced");
      const filed = fileProposal(db, capture);
      if (filed.outcome !== "stored") throw new Error("capture not staged");
      const receipt = ownerPromote(db, vault.path, filed.proposal.proposal_id, {
        sensitivity: "personal",
      });
      const pagePath = join(vault.path, receipt.page_path);
      expect(existsSync(pagePath)).toBe(true);

      const tombstone = stored(db, tombstoneInput());
      const cascade = cascadeTombstone(db, tombstone);
      expect(cascade.retractions_filed).toHaveLength(1);
      const retractionId = cascade.retractions_filed[0];
      if (retractionId === undefined) throw new Error("no retraction filed");
      const retraction = getProposal(db, retractionId);
      expect(retraction?.kind).toBe("deletion");
      expect(`${retraction?.target}.md`).toBe(receipt.page_path);
      expect(retraction?.provenance).toEqual([tombstone.event_id]);

      // Re-running the cascade files nothing new: idempotent by body hash.
      expect(cascadeTombstone(db, tombstone).retractions_filed).toHaveLength(0);

      ownerPromote(db, vault.path, retractionId, { sensitivity: "personal" });
      const archived = parseFrontmatter(readFileSync(pagePath, "utf8"));
      expect(archived.data["status"]).toBe("archived");
      // The page keeps its identity; the prior revision lands in archive/.
      expect(archived.data["id"]).toBe(filed.proposal.proposal_id);
      expect(readdirSync(join(vault.path, "archive"))).toHaveLength(1);
    } finally {
      vault.dispose();
      db.close();
    }
  });

  test("promoting a deletion proposal for a missing page is refused", () => {
    const db = vaultDb();
    const vault = tempVault();
    try {
      initVault(vault.path);
      const filed = fileProposal(db, {
        kind: "deletion",
        target: "captures/does-not-exist",
        body: "retract a page that was never written",
        frontmatter: {},
        provenance: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
        producer: "deterministic",
        confidence: 1,
      });
      if (filed.outcome !== "stored") throw new Error("proposal not staged");
      expect(() =>
        ownerPromote(db, vault.path, filed.proposal.proposal_id, {
          sensitivity: "personal",
        }),
      ).toThrow(PromoteError);
    } finally {
      vault.dispose();
      db.close();
    }
  });
});
