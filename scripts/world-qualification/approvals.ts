export interface QualificationApproval { file: string; sha256: string; endpoint_evidence: string }

/** Review pins are separate from the evaluator fingerprint, so approving its immutable output is possible.
 * Each entry pins an actual report and independently reviewed endpoint identity evidence. */
/** Known-case Concept-only confirmation; other kinds remain not_run. No runtime vocabulary change. */
export const REVIEWED_QUALIFICATIONS: readonly QualificationApproval[] = [{
  file: "concept-only-confirmation-20261021.json",
  sha256: "b895678557195b16a7a906adc60c80fefffa5d753d1f97c325047754f3581d92",
  endpoint_evidence: "8c11a57dee3fe13c5848a2066e940572595d4e30e50d3107b74063dfdc54cda1",
}];

/** Continuation permission only. This does not qualify any kind or endorse semantic results. */
export const RESUMABLE_RUNS = [{
  sha256: "a5cb97622a51fc43ccb1a12868590c1546f5ca8a40e7cfe4393b0afa102fb6d3",
  source_commit: "18ee76bd9daa3ba4e400ac3196ea8fd942747d1a",
  runner_sha256: "bd7658aac15aba3de61010fdaed85279c56b6707a35b43cca395b10edf417cd4",
}] as const;
