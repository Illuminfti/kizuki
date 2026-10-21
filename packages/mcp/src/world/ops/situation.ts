import { z } from "zod";
import { WORLD_OBJECT_REF, worldCommon, worldNode, worldRelation, worldRef } from "./shared";
import type { McpWorldOp } from "./types";

export const situationFragment: McpWorldOp = {
  name: "situation",
  fields: { situation: WORLD_OBJECT_REF.optional(), card: z.literal("kizuki.situation-card/v2").optional() },
  data: {
    "kizuki.situation-card/v2": {
      situation: worldNode("situation"), ...worldCommon,
      objective: worldRelation.nullable(), participants: z.array(WORLD_OBJECT_REF).max(256),
      commitments: z.array(z.strictObject({
        commitment: WORLD_OBJECT_REF, label: worldRelation.nullable(), debtor: z.array(worldRelation).max(256),
        creditor: z.array(worldRelation).max(256), due: z.array(worldRelation).max(256), deliverable: z.array(worldRelation).max(256),
        status: z.enum(["open","claimed_done","done","dropped"]), statusBasis: z.array(worldRef("claim")).max(128),
        overdue: z.union([z.boolean(),z.literal("unknown")]),
      })).max(128),
      statedCommitments: z.array(worldRelation).max(256),
      decisions: z.array(z.strictObject({ decision: WORLD_OBJECT_REF, label: worldRelation.nullable(),
        status: z.enum(["open","decided","reversed"]), statement: worldRelation })).max(128),
      dependencies: z.array(z.strictObject({ predicate: z.enum(["situation.requires","situation.enables","situation.blocks","situation.invalidated_by"]),
        from: WORLD_OBJECT_REF, to: WORLD_OBJECT_REF, relation: worldRelation })).max(128),
      blocker: worldRelation.nullable(), recentChange: worldRelation.nullable(), uncertainty: z.array(worldRelation).max(256),
    },
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
    "situation reads one Situation by the object token find_situations returned, passed in the field named situation. Optional card:kizuki.situation-card/v2 adds independent commitments, decisions and dependencies; omitted card preserves v1.",
};
