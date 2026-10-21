import { z } from "zod";
import { WORLD_DIFF_FIELDS } from "@kizuki/core/world";
import { shareFragment, resumeFragment } from "./resume";
import { worldRef } from "./shared";
import type { McpWorldOp } from "./types";

export const diffFragment: McpWorldOp = {
  name: "diff",
  fields: shareFragment.fields,
  data: {
    ...resumeFragment.data,
    "kizuki.world-diff/v1": {
      added: z.array(worldRef("claim")).max(128),
      removed: z.array(worldRef("claim")).max(128),
      changed: z.array(z.strictObject({ claim: worldRef("claim"), fields: z.array(z.enum(WORLD_DIFF_FIELDS)).min(1).max(5) })).max(128),
      truncated: z.boolean(),
    },
  },
  summary: "diff takes of:{operation:objectOperation, objectField:objectRef} and a required priorView from that object's same query; compares authorized qualified assertions. Incomplete reads return the fresh card, and unusable baselines require a new view.",
};
