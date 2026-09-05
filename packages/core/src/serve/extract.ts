import { sourcePolicyEpoch, sourceEventsAllowed, requireSourceEvents, isLocalSourcePort } from "../ledger/source-grants";
import { createHash } from "node:crypto";
import { parseExtractResponse } from "../producer/schema";
import { tableExists } from "../ledger/schema";
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
  readonly source_epoch?: number;
  readonly mined: ExtractMine;
  readonly drafts: readonly ClaimDraft[];
  /** The checkpoint observed before the model call. */
  readonly previous_cursor: string | null;
  readonly input_ids?: readonly string[];
  /** The batch boundary that may be committed after every draft is durable. */
  readonly cursor: LedgerCursor | null;
}

export interface DurableExtractBatch {
  readonly previous_cursor: string | null;
  readonly cursor: LedgerCursor;
  readonly drafts: readonly ClaimDraft[];
  readonly model_ref: string | null;
  readonly input_ids: readonly string[];
  readonly outcome: "ok" | "purged";
}

const NULL_CURSOR = "";
const encodeCursor = (cursor: LedgerCursor): string => `${cursor.accepted_at}\t${cursor.event_id}`;
function integrity(batch: DurableExtractBatch): string {
  return createHash("sha256").update(JSON.stringify([
    batch.previous_cursor, encodeCursor(batch.cursor), batch.model_ref, batch.input_ids, batch.outcome,
    batch.drafts.map(d => [d.kind,d.subject,d.predicate,d.object,d.polarity,d.body,d.valid_from,d.valid_to,d.confidence,d.sensitivity,d.event_ids]),
  ])).digest("hex");
}
function interval(db: Database, previous: string | null, boundary: LedgerCursor): CaptureEvent[] {
  const events = readSince(db, parseCursor(previous), EXTRACT_BATCH).events;
  const index = events.findIndex(event => event.event_id === boundary.event_id);
  const row = db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id = ?").get(boundary.event_id);
  if (index < 0 || row?.accepted_at !== boundary.accepted_at) throw new Error("durable extraction boundary is invalid");
  return events.slice(0, index + 1);
}
function saveBatch(db: Database, batch: DurableExtractBatch): void {
  db.query(`INSERT INTO extract_batches (previous_cursor,cursor,drafts,model_ref,created_at,input_ids,integrity,outcome)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(previous_cursor) DO UPDATE SET
    cursor=excluded.cursor,drafts=excluded.drafts,model_ref=excluded.model_ref,input_ids=excluded.input_ids,integrity=excluded.integrity,outcome=excluded.outcome`).run(
    batch.previous_cursor ?? NULL_CURSOR, encodeCursor(batch.cursor), JSON.stringify(batch.drafts), batch.model_ref,
    new Date().toISOString(), JSON.stringify(batch.input_ids), integrity(batch), batch.outcome,
  );
}
/** Persist the entire decision before filing; no model is called again on replay. */
export function journalExtractBatch(db: Database, mined: MineResult, modelRef: string | null): void {
  if (mined.mined.status !== "ok" || mined.cursor === null) return;
  db.transaction(() => {
    if (mined.source_epoch !== undefined && mined.source_epoch !== sourcePolicyEpoch(db)) throw new Error("source authorization changed during extraction");
    if (readExtractCursor(db) !== mined.previous_cursor) throw new Error("extraction checkpoint changed during model call");
    const events = interval(db, mined.previous_cursor, mined.cursor!);
    if (mined.input_ids !== undefined && JSON.stringify(mined.input_ids) !== JSON.stringify(events.map(event => event.event_id))) throw new Error("extraction inputs changed during model call");
    if (db.query("SELECT 1 FROM extract_batches LIMIT 1").get() !== null) throw new Error("extraction decision already pending");
    saveBatch(db, { previous_cursor: mined.previous_cursor, cursor: mined.cursor!, drafts: mined.drafts,
      model_ref: modelRef, input_ids: events.map(event => event.event_id), outcome: "ok" });
    readDurableExtractBatch(db);
  }).immediate();
}

export function readDurableExtractBatch(db: Database): DurableExtractBatch | null {
  const rows = db.query<{ previous_cursor: string; cursor: string; drafts: string; model_ref: string | null; input_ids: string | null; integrity: string | null; outcome: string }, []>(
    "SELECT * FROM extract_batches ORDER BY created_at, previous_cursor LIMIT 2",
  ).all();
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const cursor = parseCursor(row.cursor);
  const parsed = parseExtractResponse(`{"claims":${row.drafts}}`);
  if (rows.length !== 1 || cursor === null || !parsed.ok || row.previous_cursor !== (readExtractCursor(db) ?? NULL_CURSOR) ||
      ((row.integrity === null || row.input_ids === null) && (row.integrity !== null || row.input_ids !== null || row.outcome !== "ok")) ||
      !["ok", "purged"].includes(row.outcome) || (row.outcome === "ok" && parsed.claims.length === 0)) {
    throw new Error("durable extraction batch is corrupt");
  }
  const events = interval(db, row.previous_cursor || null, cursor);
  const ids = events.map(event => event.event_id);
  if (row.input_ids !== null && row.input_ids !== JSON.stringify(ids)) throw new Error("durable extraction inputs changed");
  if (parsed.claims.some(draft => draft.event_ids.some(id => !ids.includes(id)))) throw new Error("durable extraction provenance is invalid");
  for (const draft of parsed.claims) requireSourceEvents(db, draft.event_ids, { owner: false, purpose: "extract", model: true });
  const batch: DurableExtractBatch = { previous_cursor: row.previous_cursor || null, cursor, drafts: parsed.claims,
    model_ref: row.model_ref, input_ids: ids, outcome: row.outcome as DurableExtractBatch["outcome"] };
  if (row.integrity !== null && row.integrity !== integrity(batch)) throw new Error("durable extraction integrity mismatch");
  // Compatible journals predate the input manifest. Validate against the live
  // ledger before upgrading them; never infer a boundary from draft text.
  if (row.integrity === null || row.input_ids === null) saveBatch(db, batch);
  return batch;
}

/** Validate again after asynchronous filing, then advance and delete atomically. */
export function completeDurableExtractBatch(db: Database, batch: DurableExtractBatch): boolean {
  return db.transaction(() => {
    const current = readDurableExtractBatch(db);
    if (current === null || integrity(current) !== integrity(batch)) return false;
    writeCheckpoint(db, MODEL_PRODUCER_ID, EXTRACT_SOURCE_KEY, encodeCursor(batch.cursor));
    db.query("DELETE FROM extract_batches WHERE previous_cursor = ?").run(batch.previous_cursor ?? NULL_CURSOR);
    return true;
  }).immediate();
}

/** Called inside the source purge transaction, before deleting ledger rows. */
export function purgeExtractInputs(db: Database, eventIds: ReadonlySet<string>, purge: { receipt_id: string; created_at: string }): void {
  if (!tableExists(db, "extract_batches")) return;
  let batch: DurableExtractBatch | null;
  try {
    batch = readDurableExtractBatch(db);
  } catch {
    // Derived decisions cannot veto an owner purge. Do not parse or preserve
    // corrupt content; the source transaction also commits this audit marker.
    db.query("DELETE FROM extract_batches").run();
    db.query("INSERT INTO extract_invalidations(purge_receipt_id,reason,created_at) VALUES (?, 'invalid_derived_journal', ?)").run(purge.receipt_id, purge.created_at);
    batch = null;
  }
  const previous = readExtractCursor(db);
  const previousBoundary = parseCursor(previous);
  let nextPrevious = previous;
  if (previousBoundary !== null && eventIds.has(previousBoundary.event_id)) {
    const candidates = db.query<{ event_id: string; accepted_at: string }, [string, string, string]>(
      "SELECT event_id,accepted_at FROM events WHERE accepted_at < ? OR (accepted_at = ? AND event_id <= ?) ORDER BY accepted_at DESC,event_id DESC",
    ).all(previousBoundary.accepted_at, previousBoundary.accepted_at, previousBoundary.event_id);
    const surviving = candidates.find(row => !eventIds.has(row.event_id));
    nextPrevious = surviving === undefined ? null : encodeCursor(surviving);
    if (nextPrevious === null) db.query("DELETE FROM checkpoints WHERE connector_id=? AND source_key=?").run(MODEL_PRODUCER_ID, EXTRACT_SOURCE_KEY);
    else writeCheckpoint(db, MODEL_PRODUCER_ID, EXTRACT_SOURCE_KEY, nextPrevious);
  }
  if (batch === null) return;
  if (!batch.input_ids.some(id => eventIds.has(id)) && nextPrevious === previous) return;
  const remaining = batch.input_ids.filter(id => !eventIds.has(id));
  db.query("DELETE FROM extract_batches").run();
  if (remaining.length === 0) return;
  const last = remaining.at(-1)!;
  const row = db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id = ?").get(last)!;
  saveBatch(db, { ...batch, previous_cursor: nextPrevious, input_ids: remaining, cursor: { event_id: last, accepted_at: row.accepted_at },
    drafts: batch.drafts.filter(draft => !draft.event_ids.some(id => eventIds.has(id))), outcome: "purged" });
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
    if (mined.source_epoch !== undefined && mined.source_epoch !== sourcePolicyEpoch(db)) throw new Error("source authorization changed during extraction");
    if (readExtractCursor(db) !== mined.previous_cursor) return false;
    const events = interval(db, mined.previous_cursor, mined.cursor!);
    if (mined.input_ids !== undefined && JSON.stringify(mined.input_ids) !== JSON.stringify(events.map(event => event.event_id))) return false;
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
  const source_epoch = sourcePolicyEpoch(db);
  const denied = (): MineResult => ({ mined: { status: "unavailable", reason: "source authorization unavailable" }, drafts: [], previous_cursor, cursor: null });
  if (source_epoch > 0 && !isLocalSourcePort(producer)) return denied();
  const scope = { owner: false, purpose: "extract" as const, model: true, port: producer };
  const cursor = parseCursor(previous_cursor);
  const batch = readSince(db, cursor, EXTRACT_BATCH);
  if (batch.events.length === 0 || batch.cursor === null) {
    return { mined: { status: "empty" }, drafts: [], previous_cursor, cursor: null };
  }

  // Packet text that later lands in the ledger is history, not extract input.
  const usable = batch.events.filter(
    (event) => !event.deleted && !event.text.includes("KIZUKI CONTEXT v1") && sourceEventsAllowed(db, [event.event_id], scope),
  );
  if (usable.length === 0 && source_epoch > 0) return denied();
  if (usable.length === 0) {
    return { mined: { status: "empty" }, drafts: [], previous_cursor, cursor: batch.cursor, input_ids: batch.events.map(event => event.event_id) };
  }

  const subjects = new Set(usable.flatMap((event) => event.subjects.map((subject) => subject.subject_id)));
  // Filter in SQLite before applying the shared packet cap.  Selecting the
  // oldest global page first makes a mature, unrelated subject starve this
  // batch of the context the producer needs to deduplicate it.
  const known = [...subjects]
    .sort()
    .flatMap((subject) => listClaims(db, { status: "live", keyed: true, subject, limit: 32 }))
    .filter(claim => sourceEventsAllowed(db, claim.provenance, scope))
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

  if (source_epoch !== sourcePolicyEpoch(db)) return denied();
  if (produced.status === "ok" && produced.claims.some(draft => draft.event_ids.some(id => !usable.some(event => event.event_id === id)))) return denied();
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

  return { source_epoch, mined, drafts, previous_cursor, cursor: batch.cursor, input_ids: batch.events.map(event => event.event_id) };
}
