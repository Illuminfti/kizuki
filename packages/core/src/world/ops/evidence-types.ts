import type { ConceptEvidenceRef } from "../../contracts/concept-card";
import type { QuotedChunk } from "../../serving/types";
import type { TimelineExpandData } from "../../serving/expand";

export type WorldEvidenceData = {
  readonly schema: "kizuki.world-evidence/v1";
  readonly evidence: ConceptEvidenceRef;
};

/** The source form is internal, so the gate can audit and redact ordinary captured text. */
export type WorldEvidenceSource = QuotedChunk & TimelineExpandData & { readonly evidence: ConceptEvidenceRef };
/** Stage-one quoted grammar: existing wire kinds, with no raw source/event ids. */
export type WorldQuotedEvidence = TimelineExpandData & {
  readonly evidence: ConceptEvidenceRef;
  readonly text: string;
  readonly tainted: true;
};
