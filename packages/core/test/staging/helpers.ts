import { Database } from "bun:sqlite";
import type { CaptureEvent } from "../../src/contracts/event";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { sha256Hex } from "../../src/util/hash";
import { initSearch } from "../../src/search/schema";
import { initStaging } from "../../src/staging/proposals";
import type { ProposalInput } from "../../src/staging/proposals";
export { tempVault } from "../helpers/vault";

export function memoryDb(events: CaptureEvent[] = [event()]): Database {
  const db = openLedger(":memory:");
  initStaging(db);
  initSearch(db);
  for (const fixture of events) {
    const { event_id, content_hash, content_hash_version, text_hash, origin,
      origin_binding_version, origin_binding_kind, origin_binding, ...input } = fixture;
    const result = accept(db, input, { generateId: () => event_id });
    if (result.status !== "stored") throw new Error("staging event fixture was not accepted");
  }
  return db;
}

export function event(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    schema: "kizuki.event/v1",
    event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    connector_id: "fixture",
    source_record_id: "rec-1",
    kind: "message",
    occurred_at: "2026-02-28T10:30:00Z",
    observed_at: "2026-03-01T00:00:00Z",
    text: "the kettle is on",
    subjects: [{ subject_id: "person:ada", role: "from", display_name: "Ada" }],
    deleted: false,
    attachments: [],
    metadata: {},
    content_hash: "b".repeat(64),
    content_hash_version: 2,
    text_hash: sha256Hex(overrides.text ?? "the kettle is on"),
    origin: "external",
    origin_binding_version: 1,
    origin_binding_kind: "capture",
    origin_binding: "0".repeat(64),
    ...overrides,
  };
}

export function proposalInput(
  overrides: Partial<ProposalInput> = {},
): ProposalInput {
  return {
    kind: "claim",
    target: null,
    body: "a staged body",
    frontmatter: { type: "fact", title: "a staged body" },
    provenance: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
    subjects: ["person:ada"],
    producer: "deterministic",
    confidence: 1,
    ...overrides,
  };
}
