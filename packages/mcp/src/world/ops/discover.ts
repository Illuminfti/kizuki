import { z } from "zod";
import { CURSOR, LABEL, WIRE_TOKEN, WORLD_OBJECT_REF, worldCoverage } from "./shared";
import type { McpWorldOp } from "./types";

const matches = {
  matches: z
    .array(z.strictObject({ ref: WORLD_OBJECT_REF, labels: z.array(z.string().max(400)).max(256) }))
    .max(32),
  cursor: WIRE_TOKEN.nullable(),
  coverage: worldCoverage,
};

export const discoverConceptsFragment: McpWorldOp = {
  name: "find_concepts",
  fields: { label: LABEL, cursor: CURSOR },
  data: { "kizuki.concept-matches/v1": matches },
  summary:
    "find_concepts lists admitted Concepts whose label contains an optional label (default empty), a page at a time; pass the returned cursor to read the next page.",
};

export const discoverSituationsFragment: McpWorldOp = {
  name: "find_situations",
  fields: { label: LABEL, cursor: CURSOR },
  data: { "kizuki.situation-matches/v1": matches },
  summary:
    "find_situations lists admitted Situations the same way.",
};
