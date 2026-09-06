import type { Database } from "bun:sqlite";
import { tableExists } from "./schema";
import { isRfc3339 } from "../util/time";
import { isUlid } from "../util/ulid";

export class LegacyOriginRebuildRequired extends Error {
  readonly code = "legacy_origin_rebuild_required";
  constructor() { super("legacy_origin_rebuild_required"); }
}

export const LEGACY_ORIGIN_CANDIDATES = "temp.kizuki_legacy_origin_candidates";
export const LEGACY_ORIGIN_MAX_CANDIDATES = 1_000_000;
const MAX_HISTORY_ROWS = 1_000_000;
const MAX_HISTORY_BYTES = 67_108_864;

function refuse(): never { throw new LegacyOriginRebuildRequired(); }

/** Validate a bounded JSON column once before passing it to SQLite JSON walkers. */
function validateHistory(db: Database, table: "claims" | "canon_receipts" | "extract_batches", column: "provenance" | "drafts", maxBytes: number): void {
  const maxRows = table === "extract_batches" ? 1 : MAX_HISTORY_ROWS;
  // Do not parse JSON or aggregate the whole table before knowing it is small
  // enough. SQLite yields only metadata, stops at the row cap, and the iterator
  // is finalized immediately on the first excessive field or cumulative byte.
  using metadata = db.prepare<{ type: string; bytes: number | null }, []>(`SELECT
    typeof(${column}) AS type,length(CAST(${column} AS BLOB)) AS bytes
    FROM ${table} LIMIT ${maxRows + 1}`);
  let rows = 0;
  let bytes = 0;
  for (const row of metadata.iterate()) {
    if (++rows > maxRows || row.type !== "text" || row.bytes === null || row.bytes > maxBytes) refuse();
    bytes += row.bytes;
    if (bytes > MAX_HISTORY_BYTES) refuse();
  }
  using invalid = db.prepare(`SELECT 1 FROM ${table} WHERE NOT json_valid(${column}) LIMIT 1`);
  if (invalid.get() !== null) refuse();
}

function readExtractResumeCursor(
  db: Database,
  key: string,
): { cursor: string | null; bytes: number | null; type: string } | null {
  const sql = `SELECT
    CASE WHEN typeof(cursor)='text' AND length(CAST(cursor AS BLOB))<=256 THEN cursor ELSE NULL END AS cursor,
    length(CAST(cursor AS BLOB)) AS bytes,typeof(cursor) AS type`;
  if (tableExists(db, "rail_cursors")) {
    using rails = db.prepare<{ cursor: string | null; bytes: number | null; type: string }, [string]>(
      `${sql} FROM rail_cursors WHERE rail='kizuki.producer.model' AND source_key=?`,
    );
    const row = rails.get(key);
    if (row !== null) return row;
  }
  if (!tableExists(db, "checkpoints")) return null;
  using checkpoints = db.prepare<{ cursor: string | null; bytes: number | null; type: string }, [string]>(
    `${sql} FROM checkpoints WHERE connector_id='kizuki.producer.model' AND source_key=?`,
  );
  return checkpoints.get(key);
}

/**
 * All candidates share one private SQLite relation in the enclosing migration.
 * Global provenance, extract resume tokens and pending decisions are checked
 * once for the whole candidate set, never once per matching event.
 */
export function assertLegacyOriginsUnconsumed(db: Database): void {
  for (const table of ["claims", "canon_receipts"] as const) {
    if (!tableExists(db, table)) continue;
    validateHistory(db, table, "provenance", 65_536);
    using shape = db.prepare(`SELECT 1 FROM ${table} WHERE json_type(provenance)!='array'
      OR EXISTS (SELECT 1 FROM json_each(${table}.provenance) p WHERE p.type!='text') LIMIT 1`);
    if (shape.get() !== null) refuse();
    // CROSS JOIN pins the history -> JSON -> indexed candidate order. Candidate
    // count must not make the planner rescan the entire history per candidate.
    using referenced = db.prepare(`SELECT 1 FROM ${table} h
      CROSS JOIN json_each(h.provenance) p CROSS JOIN ${LEGACY_ORIGIN_CANDIDATES} c
      WHERE c.event_id=p.value LIMIT 1`);
    if (referenced.get() !== null) refuse();
  }

  let frontier: { accepted_at: string; event_id: string } | null = null;
  const extractCursor = readExtractResumeCursor(db, "extract");
  if (extractCursor !== null && extractCursor.type !== "null") {
    if (extractCursor.type !== "text" || extractCursor.bytes === null || extractCursor.bytes > 256 || extractCursor.cursor === null) refuse();
    const parts = extractCursor.cursor.split("\t");
    if (parts.length !== 2 || !isRfc3339(parts[0]!) || !isUlid(parts[1]!)) refuse();
    frontier = { accepted_at: parts[0]!, event_id: parts[1]! };
    // Preserve extraction's actual SQLite text ordering and ID tie-breaker.
    using passed = db.prepare(`SELECT 1 FROM ${LEGACY_ORIGIN_CANDIDATES}
      WHERE accepted_at<? OR (accepted_at=? AND event_id<=?) LIMIT 1`);
    if (passed.get(frontier.accepted_at, frontier.accepted_at, frontier.event_id) !== null) refuse();
  }
  // A scan marker without the frontier cannot distinguish a consumed source
  // from a still-deferred policy check. Its payload is not needed as proof.
  if (frontier === null && readExtractResumeCursor(db, "extract-deferred-scan") !== null) refuse();

  if (tableExists(db, "extract_deferred_inputs")) {
    using rebound = db.prepare(`SELECT 1 FROM extract_deferred_inputs d
      CROSS JOIN ${LEGACY_ORIGIN_CANDIDATES} c
      LEFT JOIN source_event_bindings b ON b.event_id=d.event_id
      WHERE c.event_id=d.event_id AND d.source_key IS NOT b.source_key LIMIT 1`);
    if (rebound.get() !== null) refuse();
  }

  if (tableExists(db, "extract_batches")) {
    validateHistory(db, "extract_batches", "drafts", 1_048_576);
    using shape = db.prepare("SELECT 1 FROM extract_batches WHERE json_type(drafts)!='array' LIMIT 1");
    if (shape.get() !== null) refuse();
    using pending = db.prepare(`SELECT 1 FROM extract_batches b CROSS JOIN json_tree(b.drafts) d
      CROSS JOIN ${LEGACY_ORIGIN_CANDIDATES} c WHERE d.type='text' AND c.event_id=d.value LIMIT 1`);
    if (pending.get() !== null) {
      // An old per-draft transaction could corroborate an unrelated claim while
      // discarding this input ID. Only an effects-free history proves safety.
      for (const table of ["claims", "canon_receipts"] as const) {
        if (!tableExists(db, table)) continue;
        using effects = db.prepare(`SELECT 1 FROM ${table}${table === "canon_receipts" ? " WHERE claim_ids!='[]'" : ""} LIMIT 1`);
        if (effects.get() !== null) refuse();
      }
    }
  }
}
