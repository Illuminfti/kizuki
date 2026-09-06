/**
 * Calibrated capture-note policy. Not a config flag: one named budget the
 * deterministic producer actually enforces.
 */
export const DETERMINISTIC_PRODUCER_BUDGET = {
  maxSubjectsPerEvent: 16,
  maxCaptureNoteChars: 8_000,
} as const;
