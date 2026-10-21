import { z } from "zod";
import { WIRE_TOKEN, WORLD_OBJECT_REF, worldCoverage } from "./shared";
import type { McpWorldOp } from "./types";
export const attentionFragment: McpWorldOp = {
  name: "attention", fields: {},
  data: { "kizuki.attention/v1": {
    states: z.array(z.union([
      z.strictObject({ state: z.literal("candidate"), cue: WIRE_TOKEN, source: z.enum(["blocker", "uncertainty", "commitment_due", "stale_summary"]),
        subject: WORLD_OBJECT_REF, disposition: z.enum(["none", "dismissed", "snoozed"]), snoozedUntil: z.string().max(40).nullable() }),
      z.strictObject({ state: z.literal("quiet"), reason: z.literal("no_material_change") }),
      z.strictObject({ state: z.literal("missing_coverage"), reason: z.literal("source_unobserved") }),
      z.strictObject({ state: z.literal("stale_consolidation"), reason: z.literal("summary_older_than_ledger") }),
      z.strictObject({ state: z.literal("provider_failure"), reason: z.enum(["model_unavailable", "provider_error"]) }),
    ])).min(1).max(68), coverage: worldCoverage,
  } },
  summary: "attention reads scoped goal-aware cues and distinct quiet, coverage, stale and failure states. Agents cannot dismiss, snooze or deliver cues; attention never changes factual authority or grants execution.",
};
