import type { Database } from "bun:sqlite";
import type { LlmErrorCode } from "./errors";
import type { ProducerName } from "./prompt";

export type EnrichmentOutcome =
  "filed" | "duplicate" | "suppressed" | "empty" | "rejected_output" | "error";

export type StopReason = "complete" | "budget" | "consecutive_errors";

export interface LlmRun {
  run_id: string;
  started_at: string;
  finished_at: string;
  /** Host and port only: never the path, the key, or a disk path. */
  endpoint_host: string;
  model: string;
  prompt_version: string;
  producers: ProducerName[];
  considered: number;
  sent: number;
  skipped_unlabeled: number;
  skipped_ceiling: number;
  skipped_done: number;
  skipped_short: number;
  skipped_existing: number;
  requests: number;
  input_chars: number;
  output_chars: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  proposals_filed: number;
  duplicates: number;
  suppressed: number;
  rejected_outputs: number;
  empty_outputs: number;
  errors: number;
  orphans_swept: number;
  stopped: StopReason;
}

export interface EnrichmentRecord {
  event_id: string;
  producer: ProducerName;
  prompt_version: string;
  model: string;
  run_id: string;
  /** sha256 of the wrapped user message: proof of what ran, not what it said. */
  input_hash: string;
  outcome: EnrichmentOutcome;
  proposal_ids: string[];
  error_code: LlmErrorCode | null;
  at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS llm_enrichments (
  event_id       TEXT NOT NULL,
  producer       TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model          TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  input_hash     TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  proposal_ids   TEXT NOT NULL,
  error_code     TEXT,
  at             TEXT NOT NULL,
  PRIMARY KEY (event_id, producer, prompt_version, model)
) STRICT;
CREATE INDEX IF NOT EXISTS llm_enrichments_by_run ON llm_enrichments(run_id);

CREATE TABLE IF NOT EXISTS llm_runs (
  run_id            TEXT PRIMARY KEY,
  started_at        TEXT NOT NULL,
  finished_at       TEXT NOT NULL,
  endpoint_host     TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_version    TEXT NOT NULL,
  producers         TEXT NOT NULL,
  considered        INTEGER NOT NULL,
  sent              INTEGER NOT NULL,
  skipped_unlabeled INTEGER NOT NULL,
  skipped_ceiling   INTEGER NOT NULL,
  skipped_done      INTEGER NOT NULL,
  skipped_short     INTEGER NOT NULL,
  skipped_existing  INTEGER NOT NULL,
  requests          INTEGER NOT NULL,
  input_chars       INTEGER NOT NULL,
  output_chars      INTEGER NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  proposals_filed   INTEGER NOT NULL,
  duplicates        INTEGER NOT NULL,
  suppressed        INTEGER NOT NULL,
  rejected_outputs  INTEGER NOT NULL,
  empty_outputs     INTEGER NOT NULL,
  errors            INTEGER NOT NULL,
  orphans_swept     INTEGER NOT NULL,
  stopped           TEXT NOT NULL
) STRICT;
`;

interface RunRow {
  run_id: string;
  started_at: string;
  finished_at: string;
  endpoint_host: string;
  model: string;
  prompt_version: string;
  producers: string;
  considered: number;
  sent: number;
  skipped_unlabeled: number;
  skipped_ceiling: number;
  skipped_done: number;
  skipped_short: number;
  skipped_existing: number;
  requests: number;
  input_chars: number;
  output_chars: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  proposals_filed: number;
  duplicates: number;
  suppressed: number;
  rejected_outputs: number;
  empty_outputs: number;
  errors: number;
  orphans_swept: number;
  stopped: string;
}

function tableExists(db: Database, name: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== null
  );
}

/**
 * Derived state in the vault database: dropping both tables costs only the
 * memory of what has already been spent, never canon or proposals.
 */
export function initLlm(db: Database): void {
  db.exec(SCHEMA);
}

function toRun(row: RunRow): LlmRun {
  return {
    ...row,
    producers: JSON.parse(row.producers) as ProducerName[],
    stopped: row.stopped as StopReason,
  };
}

export function insertRun(db: Database, run: LlmRun): void {
  db.query(
    `INSERT INTO llm_runs
       (run_id, started_at, finished_at, endpoint_host, model, prompt_version,
        producers, considered, sent, skipped_unlabeled, skipped_ceiling,
        skipped_done, skipped_short, skipped_existing, requests, input_chars,
        output_chars, prompt_tokens, completion_tokens, proposals_filed,
        duplicates, suppressed, rejected_outputs, empty_outputs, errors,
        orphans_swept, stopped)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.run_id,
    run.started_at,
    run.finished_at,
    run.endpoint_host,
    run.model,
    run.prompt_version,
    JSON.stringify(run.producers),
    run.considered,
    run.sent,
    run.skipped_unlabeled,
    run.skipped_ceiling,
    run.skipped_done,
    run.skipped_short,
    run.skipped_existing,
    run.requests,
    run.input_chars,
    run.output_chars,
    run.prompt_tokens,
    run.completion_tokens,
    run.proposals_filed,
    run.duplicates,
    run.suppressed,
    run.rejected_outputs,
    run.empty_outputs,
    run.errors,
    run.orphans_swept,
    run.stopped,
  );
}

/** `null` also means "never ran": reading a receipt must not create tables. */
export function lastRun(db: Database): LlmRun | null {
  if (!tableExists(db, "llm_runs")) return null;
  const row = db
    .query<RunRow, []>(
      "SELECT * FROM llm_runs ORDER BY started_at DESC, run_id DESC LIMIT 1",
    )
    .get();
  return row === null ? null : toRun(row);
}

export function listRuns(
  db: Database,
  opts: { limit?: number } = {},
): LlmRun[] {
  if (!tableExists(db, "llm_runs")) return [];
  return db
    .query<RunRow, [number]>(
      "SELECT * FROM llm_runs ORDER BY started_at DESC, run_id DESC LIMIT ?",
    )
    .all(opts.limit ?? 50)
    .map(toRun);
}

export function recordEnrichment(db: Database, record: EnrichmentRecord): void {
  db.query(
    `INSERT INTO llm_enrichments
       (event_id, producer, prompt_version, model, run_id, input_hash, outcome,
        proposal_ids, error_code, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (event_id, producer, prompt_version, model) DO UPDATE SET
       run_id = excluded.run_id,
       input_hash = excluded.input_hash,
       outcome = excluded.outcome,
       proposal_ids = excluded.proposal_ids,
       error_code = excluded.error_code,
       at = excluded.at`,
  ).run(
    record.event_id,
    record.producer,
    record.prompt_version,
    record.model,
    record.run_id,
    record.input_hash,
    record.outcome,
    JSON.stringify(record.proposal_ids),
    record.error_code,
    record.at,
  );
}

/**
 * What has already been spent on this event under this prompt and model. An
 * error row is not in the set: a failed request may be retried, a rejected
 * answer may not.
 */
export function completedProducers(
  db: Database,
  eventId: string,
  promptVersion: string,
  model: string,
): Set<ProducerName> {
  const rows = db
    .query<{ producer: string }, [string, string, string]>(
      `SELECT producer FROM llm_enrichments
        WHERE event_id = ? AND prompt_version = ? AND model = ?
          AND outcome <> 'error'`,
    )
    .all(eventId, promptVersion, model);
  return new Set(rows.map((row) => row.producer as ProducerName));
}

/** Purge deletes events; these rows cite one, so they go with it. */
export function sweepOrphans(db: Database): number {
  const before = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM llm_enrichments")
    .get();
  db.query(
    "DELETE FROM llm_enrichments WHERE event_id NOT IN (SELECT event_id FROM events)",
  ).run();
  const after = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM llm_enrichments")
    .get();
  return (before?.n ?? 0) - (after?.n ?? 0);
}
