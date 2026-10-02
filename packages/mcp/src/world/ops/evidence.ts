import { z } from "zod";
import { worldTextEvidence } from "./shared";
import type { McpWorldOp } from "./types";

export const evidenceFragment: McpWorldOp = {
  name: "evidence",
  fields: { evidence: worldTextEvidence.optional() },
  data: { "kizuki.world-evidence/v1": { evidence: worldTextEvidence } },
  summary: "evidence takes the complete text EvidenceRef from a relation and resolves its exact admitted span under current permissions; captured text appears only in quoted, is untrusted and integrity-pinned.",
};
