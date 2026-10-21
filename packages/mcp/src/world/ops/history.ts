import { z } from "zod";
import { WORLD_CONCEPT_FIELD, WORLD_SNAPSHOT_REF, worldRef, worldCommon } from "./shared";
import type { McpWorldOp } from "./types";
export const historyFragment: McpWorldOp = {
  name: "history", fields: { concept: WORLD_CONCEPT_FIELD },
  data: { "kizuki.world-history/v1": {
    snapshot: WORLD_SNAPSHOT_REF,
    transitions: z.array(z.strictObject({
      schema: z.literal("kizuki.state-transition/v1"), claim: worldRef("claim"), causeReceipt: worldRef("receipt").nullable(), recordedAt: z.string(),
      before: z.enum(["absent", "active", "retracted", "superseded"]), after: z.enum(["active", "retracted", "superseded"]),
      valid: z.union([z.strictObject({ kind: z.literal("unknown") }), z.strictObject({ kind: z.literal("known"), from: z.string(), until: z.string().nullable() })]),
    })).max(128), coverage: worldCommon.coverage,
  } },
  summary: "history reads retained Concept transitions.",
};
