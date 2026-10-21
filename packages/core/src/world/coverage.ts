import type { Database } from "bun:sqlite";
import type { ViewGap } from "../contracts/concept-card";
import { inspectCheckpoints } from "../ledger/connections";
import { tableExists } from "../ledger/schema";
import { readExtractCursor } from "../serve/extract";
import type { ServeContext } from "../serving/types";
import { authorizedEventSql } from "./policy-sql";

export type SourceCoverageGap = Extract<
  ViewGap,
  "coverage" | "pending_consolidation"
>;

/**
 * A source is visible when the principal's grant lets it read at least one live
 * event bound to it. Hidden sources never contribute a gap, a count or a text,
 * so their state cannot change what a principal sees.
 */
function visibleSources(ctx: ServeContext): string[] {
  const { clauses, bindings } = authorizedEventSql(ctx);
  return ctx.db
    .query<{ source_key: string }, (string | number)[]>(
      `SELECT sg.source_key FROM source_grants sg WHERE EXISTS (
         SELECT 1 FROM source_event_bindings b JOIN events ON events.event_id = b.event_id
          WHERE b.source_key = sg.source_key AND ${clauses.join(" AND ")})`,
    )
    .all(...bindings)
    .map((row) => row.source_key);
}

/** Import unfinished, last run errored, or the run record unreadable. A source with no checkpoint has no recorded run and adds no gap. */
function sourceIncomplete(db: Database, visible: readonly string[]): boolean {
  if (!tableExists(db, "checkpoints")) return false;
  return inspectCheckpoints(db, visible).some((item) =>
    !item.ok || !item.value.backfill_complete || item.value.last_result.errors.length > 0,
  );
}

/** The extraction cursor is `accepted_at<TAB>event_id`, the order `readSince` walks. Unreadable means start of ledger. */
function extractFrontier(
  db: Database,
): { accepted_at: string; event_id: string } | null {
  const raw = readExtractCursor(db);
  const split = raw === null ? -1 : raw.indexOf("\t");
  return raw === null || split <= 0 || split === raw.length - 1
    ? null
    : { accepted_at: raw.slice(0, split), event_id: raw.slice(split + 1) };
}

/**
 * Events the principal can read, in a source whose grant allows extraction, that
 * the extraction rail has not consumed: past its cursor, or held in its deferred
 * queue. The grant's own event limits (subjects, types, window, ceiling) apply,
 * so backlog the principal cannot read never changes what it sees.
 */
function extractBacklog(ctx: ServeContext, visible: readonly string[]): boolean {
  const { db } = ctx;
  const frontier = extractFrontier(db);
  const deferred = tableExists(db, "extract_deferred_inputs")
    ? "OR EXISTS (SELECT 1 FROM extract_deferred_inputs d WHERE d.event_id = events.event_id)"
    : "";
  const { clauses, bindings } = authorizedEventSql(ctx);
  const query = db.query<
    { pending: number },
    (string | number)[]
  >(`SELECT 1 AS pending FROM source_grants sg JOIN source_event_bindings b ON b.source_key = sg.source_key
      JOIN events ON events.event_id = b.event_id
     WHERE sg.source_key = ? AND sg.status = 'active'
       AND EXISTS (SELECT 1 FROM json_each(json_extract(sg.policy, '$.purposes')) p WHERE p.value = 'extract')
       AND ${clauses.join(" AND ")}
       AND (${frontier === null ? "1" : "events.accepted_at > ? OR (events.accepted_at = ? AND events.event_id > ?)"} ${deferred})
     LIMIT 1`);
  const cursor =
    frontier === null
      ? []
      : [frontier.accepted_at, frontier.accepted_at, frontier.event_id];
  return visible.some(
    (source) => query.get(source, ...bindings, ...cursor) !== null,
  );
}

/**
 * What the sources behind a world read have not yet delivered, for this principal only.
 * `coverage`: a visible source has unfinished history import or a failed last run.
 * `pending_consolidation`: a visible extract-granted source has readable events extraction has not consumed.
 * `coverage` is decided per visible source: checkpoint state is source-level, so a
 * visible source's import or run state is shown whole, while events outside the
 * grant never count toward visibility or backlog.
 */
export function sourceCoverage(ctx: ServeContext): SourceCoverageGap[] {
  const { db } = ctx;
  if (
    !tableExists(db, "source_grants") ||
    !tableExists(db, "source_event_bindings")
  )
    return [];
  const visible = visibleSources(ctx);
  if (visible.length === 0) return [];
  const gaps: SourceCoverageGap[] = [];
  if (sourceIncomplete(db, visible)) gaps.push("coverage");
  if (extractBacklog(ctx, visible)) gaps.push("pending_consolidation");
  return gaps;
}
