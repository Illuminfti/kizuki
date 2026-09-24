import type { Database } from "bun:sqlite";
import { isUtf16TextBoundary, type ExtractResponseV2, type ProduceInputV2, type TextAnchor } from "../contracts/producer-v2";
import { tableExists } from "../ledger/schema";
import { escapeFenceText } from "../producer/fence";

/**
 * A record too large for one typed request is extracted one segment per
 * request, or skipped with a receipt when no safe split fits a request. Its
 * progress and any skip receipt live in `extract_oversized_records`.
 */

/** The typed reason on a skipped record's receipt. */
export const SKIPPED_RECORD_REASON = "record_oversized_skipped" as const;
/** Re-queues every skipped record for extraction. */
export const RETRY_SKIPPED_COMMAND = "kizuki serve retry-skipped" as const;

/** One segment of a record, as UTF-16 offsets into the record's own text. */
export interface RecordSegment {
  readonly event_id: string;
  readonly start: number;
  readonly end: number;
  /** The record's UTF-16 length; the segment is its last when `end` reaches it. */
  readonly chars: number;
}

export interface SkippedRecord {
  readonly event_id: string;
  readonly chars: number;
  /** Text before this offset was already extracted and filed. */
  readonly done: number;
}

const WORDS = new Intl.Segmenter("und", { granularity: "word" });
const GRAPHEMES = new Intl.Segmenter("und", { granularity: "grapheme" });
/** Fence escaping lengthens `<<<KZ-`, so no split may land inside one. */
const LOOKALIKE = "<<<kz-";
/** Text past a window's end that settles the boundaries at its end. */
const LOOKAHEAD = 64;

function escapedLength(text: string, start: number, end: number): number {
  return escapeFenceText(text.slice(start, end)).length;
}

function insideLookalike(text: string, offset: number): boolean {
  for (let at = Math.max(0, offset - LOOKALIKE.length + 1); at < offset; at++) {
    if (text.slice(at, at + LOOKALIKE.length).toLowerCase() === LOOKALIKE) return true;
  }
  return false;
}

/**
 * The end of the segment that starts at `start`: at most `limit` escaped
 * characters, split at the last paragraph break in the second half of that
 * window, else the last line break there, else the last word boundary. A split
 * never lands inside a grapheme, so never inside a surrogate pair, and never
 * inside a fence look-alike. Null when no word boundary fits: one token longer
 * than a request cannot be split without cutting it.
 */
export function segmentEnd(text: string, start: number, limit: number): number | null {
  if (!Number.isSafeInteger(start) || start < 0 || start >= text.length || !Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("segment bounds are invalid");
  }
  let hi = Math.min(text.length, start + limit);
  // Escaping only lengthens text, so shrink the window until it fits escaped.
  for (let over = escapedLength(text, start, hi) - limit; over > 0; over = escapedLength(text, start, hi) - limit) hi -= over;
  if (hi === text.length) return hi;
  const after = (separator: string): number => {
    const at = text.lastIndexOf(separator, hi - separator.length);
    return at < start ? -1 : at + separator.length;
  };
  const paragraph = Math.max(after("\n\n"), after("\n\r\n"));
  const line = after("\n");
  // The window starts on a grapheme boundary, so segmenting it alone finds the
  // same boundaries as the whole record. Segments are walked, not looked up:
  // `containing()` misplaces boundaries after surrogate pairs in Bun 1.3.
  const window = text.slice(start, Math.min(text.length, hi + LOOKAHEAD)), end = hi - start;
  const graphemes = new Set<number>();
  for (const { index } of GRAPHEMES.segment(window)) {
    if (index > end) break;
    graphemes.add(index);
  }
  let word = -1;
  for (const { index } of WORDS.segment(window)) {
    if (index > end) break;
    if (index > 0 && graphemes.has(index) && !insideLookalike(text, start + index)) word = start + index;
  }
  const half = start + Math.floor((hi - start) / 2);
  for (const boundary of [paragraph, line, word]) if (boundary > half) return boundary;
  const last = Math.max(paragraph, line, word);
  return last > start ? last : null;
}

/**
 * Rewrites a segment request and its validated response into record
 * coordinates. Every anchor must fall on UTF-16 boundaries of the original
 * record and quote exactly the text the model saw.
 */
export function recordSegmentDecision(
  input: ProduceInputV2,
  response: ExtractResponseV2,
  record: { readonly event_id: string; readonly text: string },
  segment: RecordSegment,
): { readonly input: ProduceInputV2; readonly response: ExtractResponseV2 } {
  const quoted = input.events[0];
  if (input.events.length !== 1 || quoted === undefined || quoted.event_id !== record.event_id || segment.event_id !== record.event_id ||
      segment.chars !== record.text.length || quoted.text !== record.text.slice(segment.start, segment.end)) {
    throw new Error("segment input is not a slice of its record");
  }
  const shift = (anchor: TextAnchor): TextAnchor => {
    const start = segment.start + anchor.start_utf16, end = segment.start + anchor.end_utf16;
    if (anchor.event_id !== record.event_id || anchor.start_utf16 < 0 || anchor.end_utf16 <= anchor.start_utf16 || end > segment.end ||
        !isUtf16TextBoundary(record.text, start) || !isUtf16TextBoundary(record.text, end) ||
        record.text.slice(start, end) !== quoted.text.slice(anchor.start_utf16, anchor.end_utf16)) {
      throw new Error("segment anchor does not map onto its record");
    }
    return { event_id: record.event_id, start_utf16: start, end_utf16: end };
  };
  return {
    input: { ...input, events: [{ event_id: record.event_id, text: record.text }],
      supplied_refs: input.supplied_refs.map(ref => ({ id: ref.id, anchors: ref.anchors.map(shift) })) },
    response: { ...response,
      mentions: response.mentions.map(mention => ({ ...mention, anchor: shift(mention.anchor) })),
      claims: response.claims.map(claim => ({ ...claim, anchors: claim.anchors.map(shift),
        perspective: { ...claim.perspective, anchors: claim.perspective.anchors.map(shift) } })) },
  };
}

interface OversizedRow {
  readonly status: "segmenting" | "skipped";
  readonly chars: number;
  readonly done_utf16: number;
  readonly pending_end_utf16: number | null;
}

function readRow(db: Database, eventId: string): OversizedRow | null {
  if (!tableExists(db, "extract_oversized_records")) return null;
  return db.query<OversizedRow, [string]>(
    "SELECT status,chars,done_utf16,pending_end_utf16 FROM extract_oversized_records WHERE event_id=?",
  ).get(eventId);
}

function writeRow(db: Database, eventId: string, row: OversizedRow): void {
  db.query(`INSERT INTO extract_oversized_records (event_id,status,chars,done_utf16,pending_end_utf16,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(event_id) DO UPDATE SET status=excluded.status,chars=excluded.chars,done_utf16=excluded.done_utf16,
    pending_end_utf16=excluded.pending_end_utf16,updated_at=excluded.updated_at`).run(
    eventId, row.status, row.chars, row.done_utf16, row.pending_end_utf16, new Date().toISOString(),
  );
}

/** Where a record's next segment starts: after its filed text, or at its beginning. */
export function segmentStart(db: Database, eventId: string): number {
  const row = readRow(db, eventId);
  return row?.status === "segmenting" ? row.done_utf16 : 0;
}

function requireStart(db: Database, segment: RecordSegment): void {
  if (!db.inTransaction) throw new Error("segment progress requires a transaction");
  if (segmentStart(db, segment.event_id) !== segment.start) throw new Error("extraction checkpoint changed during model call");
}

/** Journals a segment decision: its end waits beside the pending batch until filing settles it. */
export function journalSegment(db: Database, segment: RecordSegment): void {
  requireStart(db, segment);
  writeRow(db, segment.event_id, { status: "segmenting", chars: segment.chars, done_utf16: segment.start, pending_end_utf16: segment.end });
}

/**
 * Settles a segment inside the transaction that files its outcome. True when
 * the record has text left, so the extraction cursor stays before it.
 */
export function completeSegment(db: Database, segment: RecordSegment): boolean {
  requireStart(db, segment);
  if (segment.end < segment.chars) {
    writeRow(db, segment.event_id, { status: "segmenting", chars: segment.chars, done_utf16: segment.end, pending_end_utf16: null });
    return true;
  }
  db.query("DELETE FROM extract_oversized_records WHERE event_id=?").run(segment.event_id);
  return false;
}

/** The segment a pending batch was journaled for, when its sole model input is mid-record. */
export function journaledSegment(db: Database, eventIds: readonly string[]): RecordSegment | null {
  const [eventId] = eventIds;
  if (eventIds.length !== 1 || eventId === undefined) return null;
  const row = readRow(db, eventId);
  if (row === null || row.status !== "segmenting" || row.pending_end_utf16 === null) return null;
  return { event_id: eventId, start: row.done_utf16, end: row.pending_end_utf16, chars: row.chars };
}

/** The skip receipt: event id, character count and filed prefix, never content. */
export function recordSkip(db: Database, skipped: SkippedRecord): void {
  if (!db.inTransaction) throw new Error("a skip receipt requires a transaction");
  writeRow(db, skipped.event_id, { status: "skipped", chars: skipped.chars, done_utf16: skipped.done, pending_end_utf16: null });
}

/** Records the extraction passed over unfinished lose their progress; skip receipts stay. */
export function releaseSegmenting(db: Database, eventIds: readonly string[]): void {
  if (!tableExists(db, "extract_oversized_records")) return;
  const remove = db.query("DELETE FROM extract_oversized_records WHERE event_id=? AND status='segmenting'");
  for (const eventId of eventIds) remove.run(eventId);
}

/** A journal discarded without filing leaves no segment pending beside it. */
export function clearPendingSegments(db: Database): void {
  if (tableExists(db, "extract_oversized_records")) {
    db.query("UPDATE extract_oversized_records SET pending_end_utf16=NULL WHERE pending_end_utf16 IS NOT NULL").run();
  }
}

export interface SkippedRecordReceipt {
  readonly reason: typeof SKIPPED_RECORD_REASON;
  readonly event_id: string;
  readonly chars: number;
  readonly done_utf16: number;
  readonly skipped_at: string;
}

export function listSkippedRecords(db: Database): SkippedRecordReceipt[] {
  if (!tableExists(db, "extract_oversized_records")) return [];
  return db.query<Omit<SkippedRecordReceipt, "reason">, []>(
    "SELECT event_id,chars,done_utf16,updated_at AS skipped_at FROM extract_oversized_records WHERE status='skipped' ORDER BY event_id",
  ).all().map(row => ({ reason: SKIPPED_RECORD_REASON, ...row }));
}

export function countOversizedRecords(db: Database): { readonly segmenting: number; readonly skipped: number } {
  if (!tableExists(db, "extract_oversized_records")) return { segmenting: 0, skipped: 0 };
  const row = db.query<{ segmenting: number | null; skipped: number | null }, []>(
    "SELECT SUM(status='segmenting') AS segmenting,SUM(status='skipped') AS skipped FROM extract_oversized_records",
  ).get();
  return { segmenting: row?.segmenting ?? 0, skipped: row?.skipped ?? 0 };
}

/** Hands a skipped record back to extraction, keeping its filed prefix; one no longer eligible is forgotten. */
export function requeueSkipped(db: Database, eventId: string, eligible: boolean): void {
  if (!db.inTransaction) throw new Error("re-queueing a skipped record requires a transaction");
  if (!eligible) db.query("DELETE FROM extract_oversized_records WHERE event_id=? AND status='skipped'").run(eventId);
  else db.query("UPDATE extract_oversized_records SET status='segmenting',updated_at=? WHERE event_id=? AND status='skipped'").run(new Date().toISOString(), eventId);
}
