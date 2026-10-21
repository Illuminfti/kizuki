import { z } from "zod";
import { WORLD_CONCEPT_FIELD, worldCommon, worldNode, worldRelation } from "./shared";
import type { McpWorldOp } from "./types";

export const conceptFragment: McpWorldOp = {
  name: "concept",
  fields: { concept: WORLD_CONCEPT_FIELD },
  data: {
    "kizuki.concept-card/v1": {
      concept: worldNode("concept"),
      ...worldCommon,
      definitions: z.array(worldRelation).max(256),
      relations: z.array(worldRelation).max(256),
      learning: z
        .array(
          z.strictObject({
            facet: z.enum(["exposure", "explanation", "application", "demonstration"]),
            assertion: worldRelation,
            assistance: z.enum(["assisted", "unassisted", "unknown"]),
            assistanceEvidence: z.array(worldRelation).max(256),
          }),
        )
        .max(256),
    },
  },
  summary:
    "concept reads a Concept ObjectRef.",
};
