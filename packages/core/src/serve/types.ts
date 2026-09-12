import type { ProducerDiagnostic } from "../contracts/producer";

/**
 * RFC 0002 §4.6 / §11: daemon rails, leases, run receipts and doctor.
 * The loop writes canon through the receipted writer; this module never
 * opens a Markdown page itself.
 */

export const SERVE_SCHEMA_VERSION = 8;

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
 * Steady-state write ratio once dedup/supersession can absorb claims.
 * The upper bound is not applied to a first-fill vault (nothing to dedup
 * against). The lower bound still fires when extracted claims are dropped.
 */
export const CALIBRATION_BAND = { min: 0.15, max: 0.75 } as const;
export const CONFIDENCE_SPREAD_MIN = 0.02;

export const WRITER_LEASE = "writer";
