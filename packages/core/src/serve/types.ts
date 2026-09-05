/**
 * RFC 0002 §4.6 / §11: daemon rails, leases, run receipts and doctor.
 * The loop writes canon through the receipted writer; this module never
 * opens a Markdown page itself.
 */

export const SERVE_SCHEMA_VERSION = 7;

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
  "active",
  "disabled",
  "masked",
  "absent",
  "none",
] as const;
export type SupervisorState = (typeof SUPERVISOR_STATES)[number];

export interface RailSpec {
  readonly rail: RailId;
  readonly period_s: number;
  readonly jitter_s: number;
  readonly enabled: boolean;
}

export const DEFAULT_RAILS: readonly RailSpec[] = [
  { rail: "sync", period_s: 15 * 60, jitter_s: 90, enabled: true },
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
  /** An interrupted producer attempt: token counts are lower bounds, not measured totals. */
  readonly usage_unknown?: boolean;
  readonly calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly unavailable: number;
  readonly wall_ms: number;
  readonly model_ref: string | null;
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
  readonly claims_deduped: number;
  readonly claims_superseded: number;
  readonly claims_rejected: Readonly<Record<string, number>>;
  readonly canon_writes: number;
  readonly canon_reverts: number;
  readonly model: RunModelReport;
  readonly retrieval: RunRetrievalReport;
  readonly budget: Readonly<Record<string, { used: number; limit: number }>>;
  readonly errors: readonly string[];
}

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
};

export interface SupervisorStatus {
  readonly kind: SupervisorKind;
  readonly state: SupervisorState;
  readonly unit: string | null;
  readonly enabled: boolean;
  readonly detail: string;
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
  readonly unavailable: number;
  readonly budget: Readonly<Record<string, { used: number; limit: number }>>;
  readonly detail: string;
}

export interface StoreDoctor {
  readonly pending_retrieval_ops: number;
  readonly oldest_retrieval_op_age_s: number | null;
  readonly pending_purge_ops: number;
  readonly oldest_purge_op_age_s: number | null;
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

export interface CalibrationDoctor {
  readonly window_days: number;
  readonly write_rate: number | null;
  readonly dedup_rate: number | null;
  readonly confidence_spread: number | null;
  readonly canon_writes_today: number;
  readonly top_subjects: { subject: string; writes: number }[];
  readonly failures: string[];
}

export interface ServeDoctorReport {
  readonly supervisor: SupervisorStatus;
  readonly intent: ServeIntent;
  readonly rails: RailDoctor[];
  readonly model: ModelDoctor;
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
