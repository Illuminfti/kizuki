export interface QualificationApproval {
  file: string;
  sha256: string;
  endpoint_evidence: string;
  /** Required for the active core semantic method; absent only on baseline or historical evidence. */
  protocol?: "core-semantic-v3";
  body_review?: { file: string; sha256: string };
}

/** Review pins are separate from the evaluator fingerprint, so approving its immutable output is possible.
 * Each entry pins an actual report and independently reviewed endpoint identity evidence. */
/** Known-case Concept-only confirmation; other kinds remain not_run. No runtime vocabulary change. */
// Historical known-case Concept confirmation, measured on d8e86f47ffc9cfbbf271030b8fae9ab41c2e2f97.
// Retained evidence; superseded as an active approval after the prompt clarification.
// report: concept-only-confirmation-20261021.json
// sha256: b895678557195b16a7a906adc60c80fefffa5d753d1f97c325047754f3581d92
// endpoint_evidence: 8c11a57dee3fe13c5848a2066e940572595d4e30e50d3107b74063dfdc54cda1
export const HISTORICAL_QUALIFICATIONS: readonly QualificationApproval[] = [{
  file: "concept-only-confirmation-20261022.json",
  sha256: "cf17a26a9f7b4d8325f2854555fd3f65d42d8924f49c1b7987ae0e746061243e",
  endpoint_evidence: "aa5c067cd97da53101f8bd5080e7c9071ea84e128296baa3c1749cc3710483da",
}];

/** INVALID historical evidence, never an active qualification. All 12 measured
 * inputs exceeded their declared 8,192-token cap. The previous scorer omitted
 * that check. Keep the original report and review bytes; no retroactive rescore,
 * larger budget, waiver, or receipt makes this campaign accepted. */
export const INVALID_HISTORICAL_QUALIFICATIONS = [{
  file: "core-semantic-core12-20261022.json",
  sha256: "33a925dd8bff2712ce4aa2979d2f3c598404c9c83dc67961fdbd9ca009c83891",
  endpoint_evidence: "c09f582552fdd003e7ad3fc2cbff501943a0c4b925704be11e7e49ccd720d436",
  protocol: "core-semantic-v3",
  body_review: { file: "core-semantic-core12-review-20261022.json", sha256: "e477df82455dda4e41899abf2222d659f153e28a30a0ec26e7e8bef08660cd83" },
  status: "INVALID", reason: "all_measured_inputs_exceeded_declared_budget",
}] as const;

/** Fresh twelve-case split, measured within the declared budget and independently reviewed. */
export const REVIEWED_QUALIFICATIONS: readonly QualificationApproval[] = [{
  file: "core-semantic-core18-20261022.json",
  sha256: "88d7d3fc67abafc67a6fef6897ba76bedd1746915c27d9e9141da86d17638272",
  endpoint_evidence: "c09f582552fdd003e7ad3fc2cbff501943a0c4b925704be11e7e49ccd720d436",
  protocol: "core-semantic-v3",
  body_review: { file: "core-semantic-core18-review-20261022.json", sha256: "f7da58b63cd493fe35d515922fb6edb80d473147f55c830168aafb057e0206a8" },
}];

/** Continuation permission only. This does not qualify any kind or endorse semantic results. */
export const RESUMABLE_RUNS = [{
  sha256: "a5cb97622a51fc43ccb1a12868590c1546f5ca8a40e7cfe4393b0afa102fb6d3",
  source_commit: "18ee76bd9daa3ba4e400ac3196ea8fd942747d1a",
  runner_sha256: "bd7658aac15aba3de61010fdaed85279c56b6707a35b43cca395b10edf417cd4",
}] as const;
