import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CaptureEvent,
  CaptureEventInput,
} from "../../src/contracts/event";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { initSearch } from "../../src/search/schema";
import { initVault } from "../../src/vault/init";
import { validEvent } from "../fixtures";

export function searchDb(): Database {
  const db = openLedger(":memory:");
  initSearch(db);
  return db;
}

export function storedEvent(
  db: Database,
  sourceRecordId: string,
  overrides: Partial<CaptureEventInput> = {},
): CaptureEvent {
  const result = accept(db, {
    ...validEvent(),
    source_record_id: sourceRecordId,
    ...overrides,
  });
  if (result.status !== "stored") {
    throw new Error(`expected stored event, got ${result.status}`);
  }
  return result.event;
}

export function tempVault(): { path: string; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), "kizuki-search-"));
  initVault(path);
  return {
    path,
    dispose: () => rmSync(path, { recursive: true, force: true }),
  };
}
