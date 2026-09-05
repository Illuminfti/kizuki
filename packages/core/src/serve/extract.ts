import type { Database } from "bun:sqlite";
import type { CaptureEvent } from "../contracts/event";
import type { ClaimDraft, ProducerPort, QuotedEvent } from "../contracts/producer";
import { predicateIds } from "../claims/predicates";
import { listClaims } from "../claims/store";
import { readCheckpoint, writeCheckpoint } from "../ledger/checkpoints";
import { readSince } from "../ledger/ledger";
import type { LedgerCursor } from "../ledger/ledger";
import { EXTRACT_BATCH, MODEL_PRODUCER_ID } from "../producer";

const EXTRACT_SOURCE_KEY = "extract";

/** Unavailable is not empty. Only empty or a successful mine advances the cursor. */
export type ExtractMine =
  | { status: "ok"; count: number }
  | { status: "empty" }
  | { status: "unavailable"; reason: string }
  | { status: "rejected"; reason: string };

export function shouldAdvanceExtractCursor(result: ExtractMine): boolean {
  switch (result.status) {
    case "ok":
    case "empty":
      return true;
    case "unavailable":
    case "rejected":
      return false;
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

export interface MineResult {
  readonly mined: ExtractMine;
  readonly drafts: readonly ClaimDraft[];
  /** The checkpoint observed before the model call. */
  readonly previous_cursor: string | null;
  /** The batch boundary that may be committed after every draft is durable. */
  readonly cursor: LedgerCursor | null;
}

export interface DurableExtractBatch {
  readonly previous_cursor: string | null;
  readonly cursor: LedgerCursor;
  readonly drafts: readonly ClaimDraft[];
}

const NULL_CURSOR = "";

/** A successful model decision is journaled before filing any individual draft. */
export function journalExtractBatch(db: Database, mined: MineResult, modelRef: string | null): void {
  if (mined.mined.status !== "ok" || mined.cursor === null) return;
  db.query(
    `INSERT OR IGNORE INTO extract_batches
       (previous_cursor, cursor, drafts, model_ref, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    mined.previous_cursor ?? NULL_CURSOR,
    `${mined.cursor.accepted_at}\t${mined.cursor.event_id}`,
    JSON.stringify(mined.drafts),
    modelRef,
    new Date().toISOString(),
  );
}

function parseDrafts(raw: string): ClaimDraft[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ClaimDraft[] : null;
  } catch {
    return null;
  }
}

export function readDurableExtractBatch(db: Database): DurableExtractBatch | null {
  const row = db.query<{ previous_cursor: string; cursor: string; drafts: string }, []>(
    "SELECT previous_cursor, cursor, drafts FROM extract_batches ORDER BY created_at, previous_cursor LIMIT 1",
  ).get();
  if (row === null) return null;
  const cursor = parseCursor(row.cursor);
  const drafts = parseDrafts(row.drafts);
  if (cursor === null || drafts === null) {
    throw new Error("durable extraction batch is corrupt");
  }
  return { previous_cursor: row.previous_cursor || null, cursor, drafts };
}

/** Cursor and journal deletion commit together only after every draft is durable. */
export function completeDurableExtractBatch(db: Database, batch: DurableExtractBatch): boolean {
  const expected = batch.previous_cursor;
  const cursor = `${batch.cursor.accepted_at}\t${batch.cursor.event_id}`;
  return db.transaction(() => {
    if (readExtractCursor(db) !== expected) return false;
    writeCheckpoint(db, MODEL_PRODUCER_ID, EXTRACT_SOURCE_KEY, cursor);
    const removed = db.query("DELETE FROM extract_batches WHERE previous_cursor = ?").run(expected ?? NULL_CURSOR);
    return removed.changes === 1;
  }).immediate();
}

function parseCursor(raw: string | null): LedgerCursor | null {
  if (raw === null || raw.length === 0) return null;
  const split = raw.indexOf("\t");
  if (split <= 0 || split === raw.length - 1) return null;
  return {
    accepted_at: raw.slice(0, split),
    event_id: raw.slice(split + 1),
  };
}

function quoted(event: CaptureEvent): QuotedEvent {
  return {
    event_id: event.event_id,
    connector_id: event.connector_id,
    occurred_at: event.occurred_at,
    observed_at: event.observed_at,
    text: event.text,
    subjects: event.subjects,
    taint: "untrusted",
  };
}

export function readExtractCursor(db: Database): string | null {
  return readCheckpoint(db, MODEL_PRODUCER_ID, EXTRACT_SOURCE_KEY);
}

/**
 * Commit only the boundary that was read before the model call. A concurrent
 * extraction pass may have advanced the checkpoint while this pass was filing
 * drafts; in that case this pass leaves it alone and its idempotent drafts can
 * be retried safely.
 */
export function commitExtractCursor(db: Database, mined: MineResult): boolean {
  if (!shouldAdvanceExtractCursor(mined.mined) || mined.cursor === null) return false;
  const cursor = `${mined.cursor.accepted_at}\t${mined.cursor.event_id}`;
  return db.transaction(() => {
    if (readExtractCursor(db) !== mined.previous_cursor) return false;
    writeCheckpoint(db, MODEL_PRODUCER_ID, EXTRACT_SOURCE_KEY, cursor);
    return true;
  }).immediate();
}

/**
 * Session/outcome mine. Unavailable or rejected never advances the cursor
 * (None ≠ []). Empty and ok do.
 */
export async function mineLiveDrafts(
  db: Database,
  producer: ProducerPort,
): Promise<MineResult> {
  const previous_cursor = readExtractCursor(db);
  const cursor = parseCursor(previous_cursor);
  const batch = readSince(db, cursor, EXTRACT_BATCH);
  if (batch.events.length === 0 || batch.cursor === null) {
    return { mined: { status: "empty" }, drafts: [], previous_cursor, cursor: null };
  }

  // Packet text that later lands in the ledger is history, not extract input.
  const usable = batch.events.filter(
    (event) => !event.deleted && !event.text.includes("KIZUKI CONTEXT v1"),
  );
  if (usable.length === 0) {
    return { mined: { status: "empty" }, drafts: [], previous_cursor, cursor: batch.cursor };
  }

  const subjects = new Set(usable.flatMap((event) => event.subjects.map((subject) => subject.subject_id)));
  // Filter in SQLite before applying the shared packet cap.  Selecting the
  // oldest global page first makes a mature, unrelated subject starve this
  // batch of the context the producer needs to deduplicate it.
  const known = [...subjects]
    .sort()
    .flatMap((subject) => listClaims(db, { status: "live", keyed: true, subject, limit: 32 }))
    .slice(0, 32);
  const produced = await producer.produce({
    events: usable.map(quoted),
    context: {
      subjects: usable.flatMap((event) => event.subjects),
      known_claims: known.map((claim) => ({
        claim_id: claim.claim_id,
        subject: claim.subject,
        predicate: claim.predicate,
        object: claim.object,
        polarity: claim.polarity,
        confidence: claim.confidence,
      })),
      predicates: [...predicateIds()],
    },
    budget: {
      max_calls: 2,
      max_input_tokens: 8_000,
      max_output_tokens: 2_000,
    },
  });

  let mined: ExtractMine;
  let drafts: readonly ClaimDraft[] = [];
  switch (produced.status) {
    case "unavailable":
      mined = { status: "unavailable", reason: produced.reason };
      break;
    case "rejected":
      mined = { status: "rejected", reason: produced.reason };
      break;
    case "ok":
      drafts = produced.claims;
      mined =
        produced.claims.length === 0
          ? { status: "empty" }
          : { status: "ok", count: produced.claims.length };
      break;
    default: {
      const _exhaustive: never = produced;
      return _exhaustive;
    }
  }

  return { mined, drafts, previous_cursor, cursor: batch.cursor };
}
