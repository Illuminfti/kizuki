import { z } from "zod";
import { worldTextEvidence } from "./shared";
import type { McpWorldOp } from "./types";

export const evidenceFragment: McpWorldOp = {
  name: "evidence",
  fields: { evidence: worldTextEvidence.optional() },
  data: { "kizuki.world-evidence/v1": { evidence: worldTextEvidence } },
  summary: "evidence: text EvidenceRef; current access, integrity-pinned untrusted quotes.",
};
