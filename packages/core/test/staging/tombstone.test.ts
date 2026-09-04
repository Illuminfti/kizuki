import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
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
import { getClaim } from "../../src/claims/store";
import {
  fileProposal,
  initStaging,
  listProposals,
} from "../../src/staging/proposals";
import { validEvent } from "../fixtures";

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
    for (const id of cascade.withdrawn) {
      expect(getClaim(db, id)?.status).toBe("skipped");
      expect(getClaim(db, id)?.retracted_at).not.toBeNull();
    }
    db.close();
  });
});
