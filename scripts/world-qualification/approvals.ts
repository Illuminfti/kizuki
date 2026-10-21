export interface QualificationApproval { file: string; sha256: string; endpoint_evidence: string }

/** Review pins are separate from the evaluator fingerprint, so approving its immutable output is possible.
 * Empty until the actual report and independent provider identity evidence receive exact-artifact review. */
export const REVIEWED_QUALIFICATIONS: readonly QualificationApproval[] = [];

/** Continuation permission only. This does not qualify any kind or endorse semantic results. */
export const RESUMABLE_RUNS = [{
  sha256: "a5cb97622a51fc43ccb1a12868590c1546f5ca8a40e7cfe4393b0afa102fb6d3",
  source_commit: "18ee76bd9daa3ba4e400ac3196ea8fd942747d1a",
  runner_sha256: "bd7658aac15aba3de61010fdaed85279c56b6707a35b43cca395b10edf417cd4",
}] as const;
