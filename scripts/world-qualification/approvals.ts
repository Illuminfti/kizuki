export interface QualificationApproval { file: string; sha256: string; endpoint_evidence: string }

/** Review pins are separate from the evaluator fingerprint, so approving its immutable output is possible.
 * Empty until the actual report and independent provider identity evidence receive exact-artifact review. */
export const REVIEWED_QUALIFICATIONS: readonly QualificationApproval[] = [];
