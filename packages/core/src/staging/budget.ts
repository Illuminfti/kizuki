/**
 * Calibrated capture-note policy. Not a config flag: one named budget the
 * deterministic producer actually enforces.
 */
export const DETERMINISTIC_PRODUCER_BUDGET = {
  maxSubjectsPerEvent: 16,
  maxCaptureNoteChars: 8_000,
} as const;

/**
 * Event kinds that carry a stream of short conversational records. Their text
 * is evidence for typed extraction and stays in the ledger, where search,
 * timeline and context read it with no model. The deterministic floor files no
 * capture note for them: one note per message onto one page per connector-day
 * recomposes the whole day on every write and outgrows the canon page limit.
 */
export const CONVERSATION_EVENT_KINDS: readonly string[] = ["message", "email"];
