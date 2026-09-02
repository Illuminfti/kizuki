import type { CaptureEvent } from "./event";
import type { Port } from "./ports";

export const LEDGER_STORE_CONTRACT = "kizuki.ledger-store/v1" as const;
export const CANON_STORE_CONTRACT = "kizuki.canon-store/v1" as const;
export const JOURNAL_STORE_CONTRACT = "kizuki.journal-store/v1" as const;
export const STORAGE_CONTRACT_MINOR = 0;
export const STORAGE_CAPABILITIES = [
  "append",
  "read",
  "remove",
  "verify-absent",
] as const;
export type StorageCapability =
  (typeof STORAGE_CAPABILITIES)[number];

export interface StoreMutationReport {
  readonly processed: number;
}

export interface StoreAbsenceProof {
  readonly checked: number;
  readonly found: string[];
  readonly store: string;
  readonly method: string;
  readonly at: string;
}

export interface LedgerAppendResult {
  readonly status: "stored" | "duplicate";
  readonly event_id: string;
}

export interface LedgerStorePort extends Port {
  append(event: CaptureEvent): Promise<LedgerAppendResult>;
  readSince(
    cursor: string | null,
    limit: number,
  ): Promise<{ events: CaptureEvent[]; cursor: string | null }>;
  remove(ids: readonly string[]): Promise<StoreMutationReport>;
  verifyAbsent(ids: readonly string[]): Promise<StoreAbsenceProof>;
}

export interface CanonStoreEntry {
  readonly rel_path: string;
  readonly content: string;
  readonly content_hash: string;
}

export interface CanonStoreWrite {
  readonly rel_path: string;
  readonly content: string;
  readonly expected_hash: string | null;
}

export interface CanonStoreWriteResult {
  readonly rel_path: string;
  readonly before_hash: string | null;
  readonly after_hash: string;
  readonly archive_path: string | null;
}

export interface CanonStorePort extends Port {
  read(rel_path: string): Promise<CanonStoreEntry | null>;
  write(input: CanonStoreWrite): Promise<CanonStoreWriteResult>;
  remove(paths: readonly string[]): Promise<StoreMutationReport>;
  verifyAbsent(paths: readonly string[]): Promise<StoreAbsenceProof>;
}

export interface JournalRecord {
  readonly record_id: string;
  readonly kind: string;
  readonly at: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface JournalStorePort extends Port {
  append(record: JournalRecord): Promise<{ duplicate: boolean }>;
  readSince(
    cursor: string | null,
    limit: number,
  ): Promise<{ records: JournalRecord[]; cursor: string | null }>;
  remove(ids: readonly string[]): Promise<StoreMutationReport>;
  verifyAbsent(ids: readonly string[]): Promise<StoreAbsenceProof>;
}

export type StoragePort =
  | LedgerStorePort
  | CanonStorePort
  | JournalStorePort;
