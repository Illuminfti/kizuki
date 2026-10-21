import { z } from "zod";
import { worldRef, worldEvidence, worldRelation } from "./shared";
import type { McpWorldOp } from "./types";
export const observationFragment: McpWorldOp = {
  name: "observation", fields: { ref: z.union([worldRef("admission"), worldRef("observation")]).optional() },
  data: { "kizuki.observation/v1": {
    ref: worldRef("observation"), evidence: z.array(worldEvidence).min(1).max(256),
    attribution: z.array(z.strictObject({ role: z.enum(["sender", "recipient", "quoted_author", "thread", "place"]), ref: worldRef("captured_subject"), basis: z.literal("source_field"), field: z.string().max(128), evidence: z.array(worldEvidence).min(1).max(256) })).max(256),
    fidelity: z.enum(["verbatim_text", "source_metadata", "lossy_transcript"]), occurred: worldRelation.shape.valid,
    sourceObservedAt: z.string().nullable(), admittedAt: z.string(),
  } },
  summary: "observation resolves an admission or observation reference to a source-faithful selection. Captured sender/recipient roles are source assertions, never semantic identity or holders. Every attribution carries its complete evidence.",
};
