import type { Database } from "bun:sqlite";
import type {
  CaptureEvent,
  CaptureEventInput,
} from "../../src/contracts/event";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { initSearch } from "../../src/search/schema";
import { validEvent } from "../fixtures";
export { tempVault } from "../helpers/vault";

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
