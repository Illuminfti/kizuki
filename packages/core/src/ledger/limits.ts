/**
 * Host-side wait when another connection holds the ledger. The serve daemon
 * writes in short per-batch transactions, so a few seconds covers ordinary
 * rail activity without letting a stuck writer block a verb indefinitely.
 */
export const LEDGER_BUSY_TIMEOUT_MS = 5_000;

/** Largest busy timeout a caller may ask for. */
export const LEDGER_BUSY_TIMEOUT_MAX_MS = 5_000;

/**
 * Attempts for one top-level immediate transaction. The busy timeout already
 * waits inside each attempt; these retries survive a writer that holds the
 * lock across several of those waits, and stay bounded so a command still
 * stops with an actionable refusal instead of hanging.
 */
export const LEDGER_BUSY_ATTEMPTS = 4;

/** Backoff before retry N of a busy immediate transaction. */
export const LEDGER_BUSY_BACKOFF_MS = 50;

/**
 * Wait for the control-store swap lock, which fails closed rather than
 * queueing. A durable connection-state swap and the row naming it must land
 * together or not at all, so a writer already holding the lock means this one
 * refuses and the caller retries the whole operation. The short wait absorbs a
 * transient overlap with an ordinary ledger batch without ever blocking a
 * publication behind a long one.
 */
export const LEDGER_CONTROL_BUSY_TIMEOUT_MS = 250;

/** Hard cap for `readSince`. Bulk walks page; they do not raise this. */
export const MAX_READ_SINCE = 1_000;

/** Internal replay page. The generator yields one row at a time. */
export const REPLAY_PAGE_SIZE = 256;

/** Doctor samples this many event rows for decode + hash checks. */
export const LEDGER_DOCTOR_ROW_CAP = 256;

export const LEDGER_ID_MAX = 128;
export const LEDGER_KIND_MAX = 128;
