/**
 * The work one world read did, counted by the pipeline itself. It is the
 * timing proxy: wall-clock time is not promised, but a reader must do the same
 * work whatever evidence it cannot see, so these two counters must not move
 * when hidden claims, hidden source state or hidden identity links change.
 */
export interface ReadStats {
  /** Rows the collect stage read from the ledger: candidate claims and scanned handles. */
  rowsExamined: number;
  /** Claims put through `eligibleWorldClaim`, whether or not they passed. */
  claimsVerified: number;
}

export const newReadStats = (): ReadStats => ({
  rowsExamined: 0,
  claimsVerified: 0,
});
