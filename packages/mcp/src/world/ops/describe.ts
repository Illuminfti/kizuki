import { z } from "zod";
import type { McpWorldOp } from "./types";

export const describeFragment: McpWorldOp = {
  name: "describe",
  fields: {},
  data: {
    "kizuki.world-describe/v1": {
      vocabulary: z.literal("kizuki.world-vocabulary/v1"),
      kinds: z
        .array(
          z.strictObject({
            id: z.string().max(64),
            state: z.enum(["shipped", "dark"]),
            population: z.enum(["typed_extraction", "extraction_off", "supplied_subject", "connector_metadata", "propose", "none"]),
          }),
        )
        .max(64),
      operations: z
        .array(
          z.strictObject({
            name: z.string().max(64),
            inputKeys: z.array(z.string().max(64)).max(32),
            resultSchemas: z.array(z.string().max(128)).max(16),
          }),
        )
        .max(128),
    },
  },
  summary:
    "describe lists the kinds this build can serve (shipped or dark), the operations with their keys and result schemas, and the vocabulary version; it carries no counts and no claims, so it reads the same for every caller. It takes only the common keys valid and knownAt: a well-formed valid changes nothing and a knownAt other than current is unavailable (history).",
};
