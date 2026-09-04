/** Host-side wait when another connection holds the ledger. */
export const LEDGER_BUSY_TIMEOUT_MS = 1_000;

/** Hard cap for `readSince`. Bulk walks page; they do not raise this. */
export const MAX_READ_SINCE = 1_000;

/** Internal replay page. The generator yields one row at a time. */
export const REPLAY_PAGE_SIZE = 256;

/** Doctor samples this many event rows for decode + hash checks. */
export const LEDGER_DOCTOR_ROW_CAP = 256;

export const LEDGER_ID_MAX = 128;
export const LEDGER_KIND_MAX = 128;
