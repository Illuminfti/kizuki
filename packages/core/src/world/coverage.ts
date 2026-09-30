import type { Database } from "bun:sqlite";
import type { ViewGap } from "../contracts/concept-card";
import { getCheckpoint, inspectConnections, type Checkpoint } from "../ledger/connections";
import { LIVE_PREDICATE } from "../ledger/ledger";
import type { ScanCoverage } from "../contracts/source-coverage";
import { tableExists } from "../ledger/schema";
import { readExtractCursor } from "../serve/extract";
import type { ServeContext } from "../serving/types";
import { authorizedEventSql } from "./policy-sql";
import { instantNanoSql, instantSecondSql } from "../query/sql";

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
function sourceIncomplete(db: Database, visible: ReadonlySet<string>): boolean {
  if (!tableExists(db, "checkpoints")) return false;
  return [...visible].some((source) => {
    const connection = db.query<{ connector_id: string }, [string]>("SELECT connector_id FROM connections WHERE source_key=?").get(source);
    if (connection === null) return false;
    const state = checkpointState(db, connection.connector_id, source);
    // Older sources with no recorded capture pass retain their world-read semantics.
    return state.unreadable || (state.checkpoint !== null &&
      (!state.checkpoint.backfill_complete || state.checkpoint.last_result.errors.length > 0));
  });
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
  if (sourceIncomplete(db, new Set(visible))) gaps.push("coverage");
  if (extractBacklog(ctx, visible)) gaps.push("pending_consolidation");
  return gaps;
}


export interface SourceCoverageReport {
  connector_id: string;
  source_key: string;
  /** Unknown until a connector supplies an inventory; withheld from scoped readers. */
  scanned: number | null;
  ingested: number;
  excluded: ScanCoverage["excluded"];
  pending: number | null;
  failed: number | null;
  truncated: boolean | null;
  first_occurred_at: string | null;
  last_occurred_at: string | null;
  backfill_complete: boolean;
  backfill_state: "never_run" | "in_progress" | "complete" | "failed" | "unreadable";
  last_successful_pass_at: string | null;
  last_error_class: string | null;
  blind_spots: { reason: string; detail: string; next_step: string }[];
}

function checkpointState(db: Database, connector: string, source: string): { checkpoint: Checkpoint | null; unreadable: boolean } {
  try { return { checkpoint: getCheckpoint(db, connector, source), unreadable: false }; }
  catch { return { checkpoint: null, unreadable: true }; }
}

function coverageReports(db: Database, sources: readonly string[] | null, filter: { clauses: string[]; bindings: (string | number)[] } | null, inventoryVisible = filter === null): SourceCoverageReport[] {
  const reports: SourceCoverageReport[] = [];
  for (const item of inspectConnections(db, { includeDisconnected: true, ...(sources === null ? {} : { sourceKeys: sources }) })) {
    const source = item.ok ? item.value.source_key : item.source_key;
    const connector = item.ok ? item.value.connector_id : item.connector_id;
    const { checkpoint, unreadable } = checkpointState(db, connector, source);
    const pass = checkpoint?.last_result.coverage;
    const scan = inventoryVisible ? pass?.scan : null;
    const clauses = filter?.clauses ?? [LIVE_PREDICATE];
    const bindings = filter?.bindings ?? [];
    const where = `b.source_key=? AND ${clauses.join(" AND ")}`;
    // Shift supported epoch seconds into positive, fixed-width keys. Reuse
    // grant-window ordering, including nanoseconds, leap seconds and offsets.
    const totals = db.query<{ ingested: number; first: string | null; last: string | null }, (string | number)[]>(
      `WITH eligible AS MATERIALIZED (
         SELECT events.occurred_at,
           printf('%012d:%09d', ${instantSecondSql("events.occurred_at")} + 62167219200,
             ${instantNanoSql("events.occurred_at")}) AS instant
         FROM source_event_bindings b JOIN events ON events.event_id=b.event_id WHERE ${where}
       ) SELECT (SELECT count(*) FROM eligible) AS ingested,
         (SELECT occurred_at FROM eligible ORDER BY instant, occurred_at LIMIT 1) AS first,
         (SELECT occurred_at FROM eligible ORDER BY instant DESC, occurred_at LIMIT 1) AS last`
    ).get(source, ...bindings)!;
    const errors = checkpoint?.last_result.errors.length ?? 0;
    const complete = checkpoint?.backfill_complete === true;
    const state = unreadable ? "unreadable" : errors > 0 ? "failed" : complete ? "complete" : checkpoint === null ? "never_run" : "in_progress";
    const blind_spots: SourceCoverageReport["blind_spots"] = [];
    const add = (reason: string, detail: string, next_step: string) => blind_spots.push({ reason, detail, next_step });
    if (!item.ok || unreadable) add("unreadable_state", "Source state is unreadable.", "Restore source state before retrying capture.");
    if (item.ok && item.value.disconnected_at !== null) add("disabled_source", "Source is disconnected.", "Reconnect this source to resume capture.");
    const grant = db.query<{ status: string }, [string]>("SELECT status FROM source_grants WHERE source_key=?").get(source);
    if (grant?.status !== "active") add("paused_source", "Capture consent is absent or inactive.", "Inspect source consent before resuming capture.");
    if (pass?.last_successful_pass_at == null && !complete) add("never_completed_pass", "No successful complete pass is recorded.", "Run backfill for this source and inspect its error class.");
    if (scan == null && inventoryVisible) add("inventory_unknown", "This source has no recorded scan inventory.", "Run a capture pass; connectors without inventory report unknown counts.");
    for (const exclusion of scan?.excluded ?? []) add("excluded_by_rule", `${exclusion.rule}: ${exclusion.count} matching entries (subtree contents unknown).`, "Inspect the exclusion rule and enroll omitted content separately if needed.");
    for (const content of scan?.content_exclusions ?? []) add("content_excluded", content, "Capture this content through a supported separate source if needed.");
    if (scan?.truncated) add("scan_truncated", "Scan stopped at a connector bound; remaining inventory is unknown.", "Split the source into smaller independent roots.");
    if (errors > 0 || (scan?.failed ?? 0) > 0) add("failed_pass", "The latest capture pass has failures.", "Resolve the error class and retry this source.");
    reports.push({ connector_id: connector, source_key: source, scanned: scan?.scanned ?? null, ingested: totals.ingested,
      excluded: scan?.excluded ?? [], pending: scan?.pending ?? null, failed: scan == null ? (errors > 0 ? errors : null) : Math.max(scan.failed, errors),
      truncated: scan?.truncated ?? null, first_occurred_at: totals.first, last_occurred_at: totals.last,
      backfill_complete: complete, backfill_state: state, last_successful_pass_at: pass?.last_successful_pass_at ?? null,
      last_error_class: unreadable ? "unreadable_state" : pass?.last_error_class ?? (errors > 0 ? "failed" : null), blind_spots });
  }
  return reports.sort((a, b) => a.source_key.localeCompare(b.source_key));
}

/** Trusted local owner diagnostics; includes enrolled sources with no readable records. */
export function inspectSourceCoverage(db: Database): SourceCoverageReport[] {
  return coverageReports(db, null, null);
}

/** Same authorization and source visibility as world reads. Inventory is owner-only. */
export function readSourceCoverage(ctx: ServeContext): SourceCoverageReport[] {
  if (!tableExists(ctx.db, "source_grants") || !tableExists(ctx.db, "source_event_bindings")) return [];
  return coverageReports(ctx.db, visibleSources(ctx), authorizedEventSql(ctx), ctx.principal.kind === "owner");
}
