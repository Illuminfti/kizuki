import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureEvent } from "../../src/contracts/event";
import { initSearch } from "../../src/search/schema";
import { initStaging } from "../../src/staging/proposals";
import type { ProposalInput } from "../../src/staging/proposals";

export function memoryDb(): Database {
  const db = new Database(":memory:");
  initStaging(db);
  initSearch(db);
  return db;
}

export function tempVault(): { path: string; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), "kizuki-vault-"));
  return {
    path,
    dispose: () => rmSync(path, { recursive: true, force: true }),
  };
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
