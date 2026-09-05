import type { Database } from "bun:sqlite";
import type { EventRow } from "./event-record";
import { tableExists } from "./schema";
import { isRfc3339 } from "../util/time";
import { isUlid } from "../util/ulid";

export class LegacyOriginRebuildRequired extends Error {
  readonly code = "legacy_origin_rebuild_required";
  constructor() { super("legacy_origin_rebuild_required"); }
}

function refuse(): never { throw new LegacyOriginRebuildRequired(); }

/** A receipt match was previously model-eligible. Missing effect provenance cannot prove safety. */
export function assertLegacyOriginUnconsumed(db: Database, event: Pick<EventRow, "event_id" | "accepted_at">): void {
  for (const table of ["claims", "canon_receipts"] as const) {
    if (!tableExists(db, table)) continue;
    using invalid = db.prepare(`SELECT 1 FROM ${table} WHERE
      typeof(provenance)!='text' OR length(CAST(provenance AS BLOB))>65536 OR NOT json_valid(provenance) LIMIT 1`);
    if (invalid.get() !== null) refuse();
    using shape = db.prepare(`SELECT 1 FROM ${table} WHERE json_type(provenance)!='array'
      OR EXISTS (SELECT 1 FROM json_each(${table}.provenance) p WHERE p.type!='text') LIMIT 1`);
    if (shape.get() !== null) refuse();
    using referenced = db.prepare(`SELECT 1 FROM ${table},json_each(${table}.provenance) p WHERE p.value=? LIMIT 1`);
    if (referenced.get(event.event_id) !== null) refuse();
  }

  let frontier: { accepted_at: string; event_id: string } | null = null;
  if (tableExists(db, "checkpoints")) {
    using select = db.prepare<{ cursor: string | null }, [string]>(`SELECT cursor FROM checkpoints
      WHERE connector_id='kizuki.producer.model' AND source_key=?`);
    const raw = select.get("extract")?.cursor;
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== "string" || raw.length > 256) refuse();
      const parts = raw.split("\t");
      if (parts.length !== 2 || !isRfc3339(parts[0]!) || !isUlid(parts[1]!)) refuse();
      frontier = { accepted_at: parts[0]!, event_id: parts[1]! };
      // Extraction uses this exact SQLite text ordering, including its ID tie-breaker.
      using passed = db.prepare("SELECT 1 WHERE ? < ? OR (? = ? AND ? <= ?)");
      if (passed.get(event.accepted_at, frontier.accepted_at, event.accepted_at, frontier.accepted_at,
        event.event_id, frontier.event_id) !== null) refuse();
    }
    // Completed deferred entries were deleted. A scan marker without the frontier
    // cannot distinguish completion from a still-deferred source-policy check.
    if (frontier === null && select.get("extract-deferred-scan") !== null) refuse();
  }

  if (tableExists(db, "extract_deferred_inputs")) {
    using rebound = db.prepare(`SELECT 1 FROM extract_deferred_inputs d
      LEFT JOIN source_event_bindings b ON b.event_id=d.event_id
      WHERE d.event_id=? AND d.source_key IS NOT b.source_key LIMIT 1`);
    if (rebound.get(event.event_id) !== null) refuse();
  }

  if (tableExists(db, "extract_batches")) {
    using invalid = db.prepare(`SELECT 1 FROM extract_batches WHERE
      typeof(drafts)!='text' OR length(CAST(drafts AS BLOB))>1048576 OR NOT json_valid(drafts) LIMIT 1`);
    if (invalid.get() !== null) refuse();
    using pending = db.prepare(`SELECT 1 FROM extract_batches b,json_tree(b.drafts) d
      WHERE d.type='text' AND d.value=? LIMIT 1`);
    if (pending.get(event.event_id) !== null) {
      // The old per-draft transaction could have corroborated an unrelated existing
      // claim without retaining this input ID. Only an effects-free history proves
      // that the immutable pending decision can be filtered without undoing effects.
      for (const table of ["claims", "canon_receipts"] as const) {
        if (!tableExists(db, table)) continue;
        using effects = db.prepare(`SELECT 1 FROM ${table}${table === "canon_receipts" ? " WHERE claim_ids!='[]'" : ""} LIMIT 1`);
        if (effects.get() !== null) refuse();
      }
    }
  }
}
