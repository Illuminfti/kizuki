import { z } from "zod";
import { WORLD_OBJECT_REF, worldCommon, worldNode, worldRelation } from "./shared";
import type { McpWorldOp } from "./types";

export const situationFragment: McpWorldOp = {
  name: "situation",
  fields: { situation: WORLD_OBJECT_REF.optional() },
  data: {
    "kizuki.situation-card/v1": {
      situation: worldNode("situation"),
      ...worldCommon,
      objective: worldRelation.nullable(),
      participants: z.array(WORLD_OBJECT_REF).max(256),
      commitments: z.array(worldRelation).max(256),
      blocker: worldRelation.nullable(),
      recentChange: worldRelation.nullable(),
      uncertainty: z.array(worldRelation).max(256),
    },
  },
  summary:
    "situation reads one Situation by the object token find_situations returned, passed in the field named situation.",
};
