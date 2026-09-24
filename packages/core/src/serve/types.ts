import type { ProducerDiagnostic } from "../contracts/producer";
import { MAX_V2_EVENTS, MAX_V2_OUTPUT_TOKENS } from "../contracts/producer-v2";

/**
 * RFC 0002 §4.6 / §11: daemon rails, leases, run receipts and doctor.
 * The loop writes canon through the receipted writer; this module never
 * opens a Markdown page itself.
 */

export const SERVE_SCHEMA_VERSION = 9;

export const RUN_RECEIPTS_PATH = ".kizuki/run-receipts.jsonl";
export const SERVE_INTENT_PATH = ".kizuki/serve-intent";
export const VAULT_ID_PATH = ".kizuki/vault-id";
export const SERVE_PID_PATH = ".kizuki/serve.pid";
export const SERVE_TOKEN_PATH = ".kizuki/serve.token";

export const HEARTBEAT_SECONDS = 10;
export const LEASE_RECLAIM_HEARTBEATS = 3;
export const EMPTY_STREAK = 5;
export const RETRIEVAL_SLA_SECONDS = 900;
export const RUN_RECEIPT_RETENTION_DAYS = 7;
/**
 * Steady-state keep ratio, chosen against a vault whose corpus already
 * absorbs drafts: RFC 0002 E4 measured 69.9% kept against a 33-50% target,
 * so 0.75 is the ceiling above which dedup and supersession are provably
 * not biting, and 0.15 the floor below which admission is discarding
 * evidence the producer paid to extract. Both numbers describe a running
 * vault, not a first fill.
 *
 * The band is therefore enforced only in steady state. `CalibrationDoctor`
 * reports `bands_enforced` with the reason it was skipped: a true initial
 * capture (a live or superseded corpus exists, none of it was asserted
 * before the latest extracting receipt started, and every asserted_at
 * parses), a sample too small to be a control, an unreadable receipt clock,
 * or no receipts at all. A later extracting receipt in the same week
 * applies both bounds once that corpus is present.
 */
export const CALIBRATION_BAND = { min: 0.15, max: 0.75 } as const;
export const CONFIDENCE_SPREAD_MIN = 0.02;

export const WRITER_LEASE = "writer";

export const RAIL_IDS = [
  "sync",
  "retrieval-sweep",
  "purge-sweep",
  "embed-backfill",
  "brief",
  "doctor-sweep",
  "journal-prune",
] as const;
export type RailId = (typeof RAIL_IDS)[number];

export const RUN_STATUSES = ["ok", "degraded", "stopped", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const CRASH_POINTS = ["after-file", "after-jsonl", "after-db"] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export const SERVE_INTENTS = ["installed", "opted-out", "none"] as const;
export type ServeIntent = (typeof SERVE_INTENTS)[number];

export const SUPERVISOR_KINDS = ["systemd", "launchd", "none"] as const;
export type SupervisorKind = (typeof SUPERVISOR_KINDS)[number];

export const SUPERVISOR_STATES = [
  "unknown",
  "active",
  "disabled",
  "masked",
  "absent",
  "none",
] as const;
export type SupervisorState = (typeof SUPERVISOR_STATES)[number];

export const DEFAULT_SYNC_PERIOD_S = 15 * 60;
export const SYNC_PERIOD_BOUNDS = { min: 60, max: 86_400 } as const;

export interface RailSpec {
  readonly rail: RailId;
  readonly period_s: number;
  readonly jitter_s: number;
  readonly enabled: boolean;
}

export const DEFAULT_RAILS: readonly RailSpec[] = [
  { rail: "sync", period_s: DEFAULT_SYNC_PERIOD_S, jitter_s: 90, enabled: true },
  { rail: "retrieval-sweep", period_s: 5 * 60, jitter_s: 0, enabled: true },
  { rail: "purge-sweep", period_s: 10 * 60, jitter_s: 0, enabled: true },
  { rail: "embed-backfill", period_s: 60, jitter_s: 0, enabled: true },
  { rail: "brief", period_s: 24 * 60 * 60, jitter_s: 0, enabled: true },
  { rail: "doctor-sweep", period_s: 60 * 60, jitter_s: 0, enabled: true },
  { rail: "journal-prune", period_s: 24 * 60 * 60, jitter_s: 0, enabled: true },
];

export interface ScheduleRow {
  readonly rail: RailId;
  readonly period_s: number;
  readonly jitter_s: number;
  readonly enabled: boolean;
  readonly last_run_at: string | null;
  readonly next_run_at: string | null;
}

export interface LeaseRow {
  readonly name: string;
  readonly holder_pid: number;
  readonly holder_boot_id: string;
  readonly acquired_at: string;
  readonly heartbeat_at: string;
  readonly ttl_s: number;
}

export interface RunModelReport {
  /** Stable identity of the original reference, before display redaction. */
  readonly model_ref_sha256?: string;
  /** The pass's final request's failure. A pass is judged by how it ended. */
  readonly diagnostic?: ProducerDiagnostic;
  /** The pass's final producer attempt was interrupted or unverifiable: its token counts are unknown. */
  readonly usage_unknown?: boolean;
  /** Requests the model answered with a usable response. Absent on older receipts and passes without a request. */
  readonly answered?: number;
  /** How the pass's final request ended. Absent on older receipts and passes without a request. */
  readonly last_request?: "answered" | "failed";
  readonly calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly unavailable: number;
  readonly wall_ms: number;
  readonly model_ref: string | null;
}

/** Records too large for one request that a pass handled itself. */
export interface RunOversizedReport {
  /** Segments filed, one request each. */
  readonly segments: number;
  /** Records passed over with a `record_oversized_skipped` receipt. */
  readonly skipped: number;
}

export interface RunRetrievalReport {
  readonly upserts: number;
  readonly removals: number;
  readonly pending_ops: number;
  readonly degraded: readonly string[];
}

export interface RunExecution {
  readonly instance_id: string;
  readonly pid: number;
  readonly boot_id: string;
  readonly trigger: "scheduled" | "manual" | "once";
  readonly due_at: string | null;
}

export interface RunScheduleTransition {
  readonly previous_due_at: string | null;
  readonly next_run_at: string;
  readonly period_s: number;
  readonly brief_hour: number | null;
}

export interface RunReceipt {
  /** Durable scheduler compare-and-advance intent, replayed with the receipt row. */
  readonly schedule_transition?: RunScheduleTransition;
  /** Legacy receipts omit this and cannot prove automatic artifact-bound execution. */
  readonly execution?: RunExecution;
  readonly run_id: string;
  readonly rail: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly status: RunStatus;
  readonly stopped: string | null;
  readonly events_synced: number;
  readonly events_stored: number;
  readonly events_duplicate: number;
  readonly events_self_skipped: number;
  readonly claims_extracted: number;
  readonly claims_written: number;
  /**
   * Model-produced claims among `claims_written`. Imported and owner claims
   * are written by the same pass but are not extraction output, so the
   * calibration write rate uses this count. Absent on older receipts.
   */
  readonly claims_written_extracted?: number;
  readonly claims_deduped: number;
  readonly claims_superseded: number;
  readonly claims_rejected: Readonly<Record<string, number>>;
  /**
   * Records extraction passed over without claims: too large for one request,
   * or rejected on their own twice in a row. Absent on older receipts.
   */
  readonly records_skipped?: number;
  readonly canon_writes: number;
  readonly canon_reverts: number;
  readonly model: RunModelReport;
  /** Present when the pass segmented or skipped a record too large for one request. */
  readonly oversized?: RunOversizedReport;
  readonly retrieval: RunRetrievalReport;
  readonly budget: Readonly<Record<string, { used: number; limit: number }>>;
  readonly errors: readonly string[];
}

/**
 * Owner-configured extraction throughput (`[extraction]` in serve.toml). The
 * pass limit applies to every producer; the per-request limits apply to typed
 * world extraction (producer v2) only.
 */
export interface ExtractionConfig {
  /** Extraction steps one sync pass may take. A step makes at most one model request and files its decision before the next. */
  readonly max_calls_per_pass: number;
  /** Records one typed request may carry. */
  readonly records_per_request: number;
  /** Estimated input tokens one typed request may reserve. */
  readonly max_input_tokens: number;
  /** Output tokens one typed request reserves, reasoning included. */
  readonly max_output_tokens: number;
  /** Seconds after which a pass starts no further step; the request in flight finishes. */
  readonly max_pass_seconds: number;
}

/** Inclusive bounds; an out-of-range or non-integer value keeps its default. */
export const EXTRACTION_BOUNDS = {
  max_calls_per_pass: { min: 1, max: 256 },
  records_per_request: { min: 1, max: MAX_V2_EVENTS },
  max_input_tokens: { min: 2_000, max: 32_000 },
  max_output_tokens: { min: 1_024, max: MAX_V2_OUTPUT_TOKENS },
  max_pass_seconds: { min: 30, max: 600 },
} as const satisfies Record<keyof ExtractionConfig, { min: number; max: number }>;

export const DEFAULT_EXTRACTION_CONFIG: ExtractionConfig = {
  max_calls_per_pass: 1,
  records_per_request: 2,
  max_input_tokens: 8_000,
  max_output_tokens: 8_192,
  max_pass_seconds: 60,
};

export interface ServeConfig {
  readonly memory_max: string;
  readonly cpu_quota: string;
  readonly nice: number;
  readonly brief_hour: number;
  readonly bind_host: string;
  readonly bind_port: number;
  readonly http: boolean;
  readonly canon_writes_per_run: number;
  readonly canon_writes_per_day: number;
  readonly journal_retention_days: number;
  /** Sync rail period, applied to the persisted schedule when the service starts. */
  readonly sync_period_s: number;
  readonly extraction: ExtractionConfig;
}

export const DEFAULT_SERVE_CONFIG: ServeConfig = {
  memory_max: "2G",
  cpu_quota: "60%",
  nice: 10,
  brief_hour: 7,
  bind_host: "127.0.0.1",
  bind_port: 0,
  http: true,
  canon_writes_per_run: 32,
  canon_writes_per_day: 256,
  journal_retention_days: RUN_RECEIPT_RETENTION_DAYS,
  sync_period_s: DEFAULT_SYNC_PERIOD_S,
  extraction: DEFAULT_EXTRACTION_CONFIG,
};

export interface SupervisorStatus {
  readonly kind: SupervisorKind;
  readonly state: SupervisorState;
  readonly unit: string | null;
  readonly enabled: boolean;
  readonly detail: string;
}

/** How the supervisor says the unit's last run ended, in its own words:
 * systemd's Result (exit-code, start-limit-hit, oom-kill, ...) and the main
 * process's exit status. */
export interface SupervisorLastExit {
  readonly result: string;
  readonly exit_status: number | null;
}

export interface RailDoctor {
  readonly rail: RailId;
  readonly last_receipt_at: string | null;
  readonly age_s: number | null;
  readonly period_s: number;
  readonly status: "ok" | "down" | "idle";
  readonly reason: string | null;
  readonly empty_streak: number;
}

export interface ModelDoctor {
  readonly canon_writing: "on" | "off" | "unverified";
  readonly model_ref: string | null;
  readonly last_success_at: string | null;
  readonly last_failure: { readonly at: string; readonly detail: string } | null;
  /** Failure of the newest attributable attempt, independently of historical failures. */
  readonly current_failure: { readonly at: string; readonly detail: string } | null;
  readonly unattributed_receipts: number;
  /** Newer unreadable/ambiguous history or an omitted deciding attempt prevents current attribution. */
  readonly history_unverified: boolean;
  /** Historical last_success, last_failure and counts describe only the selected receipt window. */
  readonly history_truncated: boolean;
  readonly unavailable: number;
  readonly budget: Readonly<Record<string, { used: number; limit: number }>>;
  readonly detail: string;
}

export interface StoreDoctor {
  readonly pending_retrieval_ops: number;
  readonly oldest_retrieval_op_age_s: number | null;
  readonly pending_purge_ops: number;
  readonly oldest_purge_op_age_s: number | null;
  /** Successful embed-backfill docs/s, or null when doctor has no measured throughput. */
  readonly embedding_throughput_docs_per_s: number | null;
  readonly orphan_run_receipts: string[];
  readonly derived: {
    readonly search: { rebuilt_at: string | null; doc_count: number };
    readonly graph: { rebuilt_at: string | null; doc_count: number };
  };
  readonly writers: {
    readonly loop: number;
    readonly correction: number;
    readonly import: number;
    readonly revert: number;
  };
  readonly origin: {
    readonly machine: number;
    readonly human: number;
  };
  readonly degraded: string[];
}

/** Why `CALIBRATION_BAND` was measured but not used as a verdict. */
export const CALIBRATION_BANDS_REASONS = [
  "no-receipts",
  "insufficient-sample",
  "initial-capture",
  "receipt-clock-unparseable",
] as const;
export type CalibrationBandsReason = (typeof CALIBRATION_BANDS_REASONS)[number];

export interface CalibrationDoctor {
  readonly window_days: number;
  readonly write_rate: number | null;
  readonly dedup_rate: number | null;
  readonly confidence_spread: number | null;
  readonly canon_writes_today: number;
  readonly top_subjects: { subject: string; writes: number }[];
  /**
   * False when `write_rate` is reported for information only. The rate
   * itself is never adjusted; only the band verdict is withheld.
   */
  readonly bands_enforced: boolean;
  readonly bands_reason: CalibrationBandsReason | null;
  readonly failures: string[];
}

/** Effective extraction throughput. `sync_period_s` is the persisted schedule the loop runs on. */
export interface ThroughputDoctor extends ExtractionConfig {
  readonly sync_period_s: number;
  /** serve.toml's period; a service start applies it when it differs. */
  readonly configured_sync_period_s: number;
  /** Records extraction passed over in the doctor's receipt window. */
  readonly records_skipped: number;
  readonly detail: string;
}

/** Typed extraction records too large for one request. */
export interface OversizedDoctor {
  /** Records the loop is extracting one segment per request. */
  readonly segmenting: number;
  /** Records passed over with a `record_oversized_skipped` receipt. */
  readonly skipped: number;
  /** The command that re-queues skipped records; null when none are skipped. */
  readonly retry: string | null;
  readonly detail: string;
}

export interface ServeDoctorReport {
  readonly supervisor: SupervisorStatus;
  /** Read only for an installed unit that is not running; null otherwise. */
  readonly supervisor_exit: SupervisorLastExit | null;
  readonly intent: ServeIntent | "unknown";
  readonly rails: RailDoctor[];
  readonly model: ModelDoctor;
  readonly throughput: ThroughputDoctor;
  readonly oversized: OversizedDoctor;
  readonly stores: StoreDoctor;
  readonly calibration: CalibrationDoctor;
  readonly ok: boolean;
  readonly failures: string[];
}

export class InjectedCrash extends Error {
  override readonly name = "InjectedCrash";

  constructor(readonly point: CrashPoint) {
    super(`injected crash at ${point}`);
  }
}

export class ServeDaemonError extends Error {
  override readonly name = "ServeDaemonError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function emptyRunTotals(): Pick<
  RunReceipt,
  | "events_synced"
  | "events_stored"
  | "events_duplicate"
  | "events_self_skipped"
  | "claims_extracted"
  | "claims_written"
  | "claims_deduped"
  | "claims_superseded"
  | "claims_rejected"
  | "canon_writes"
  | "canon_reverts"
  | "model"
  | "retrieval"
  | "budget"
  | "errors"
> {
  return {
    events_synced: 0,
    events_stored: 0,
    events_duplicate: 0,
    events_self_skipped: 0,
    claims_extracted: 0,
    claims_written: 0,
    claims_deduped: 0,
    claims_superseded: 0,
    claims_rejected: {},
    canon_writes: 0,
    canon_reverts: 0,
    model: {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      unavailable: 0,
      wall_ms: 0,
      model_ref: null,
    },
    retrieval: {
      upserts: 0,
      removals: 0,
      pending_ops: 0,
      degraded: [],
    },
    budget: {},
    errors: [],
  };
}

export function isRailId(value: string): value is RailId {
  return (RAIL_IDS as readonly string[]).includes(value);
}

export function isCrashPoint(value: string): value is CrashPoint {
  return (CRASH_POINTS as readonly string[]).includes(value);
}

export function isServeIntent(value: string): value is ServeIntent {
  return (SERVE_INTENTS as readonly string[]).includes(value);
}
