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
  summary: "diff: of+same-query priorView; changes, incomplete card or new_view_required.",
};
