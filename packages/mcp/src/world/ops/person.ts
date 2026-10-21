import { z } from "zod";
import { CURSOR, LABEL, WIRE_TOKEN, WORLD_OBJECT_REF, worldCommon, worldCoverage, worldNode, worldRelation } from "./shared";
import type { McpWorldOp } from "./types";
const relations = z.array(worldRelation).max(256);
export const personFragment: McpWorldOp = {
  name: "person", fields: { person: WORLD_OBJECT_REF.optional() },
  data: { "kizuki.person-card/v1": {
    person: worldNode("person"), ...worldCommon, roles: relations, relationships: relations,
    perspectives: z.array(z.strictObject({ holder: WORLD_OBJECT_REF.nullable(), speaker: WORLD_OBJECT_REF.nullable(),
      mode: z.enum(["asserted", "quoted", "reported", "hypothetical", "suggested", "questioned", "uncertain"]), relations })).max(256),
    agreedDeadline: z.null(),
  } },
  summary: "person: attributed statements need not agree.",
};
export const findPeopleFragment: McpWorldOp = {
  name: "find_people", fields: { label: LABEL, cursor: CURSOR },
  data: { "kizuki.person-matches/v1": { matches: z.array(z.strictObject({ ref: WORLD_OBJECT_REF,
    labels: z.array(z.string().max(400)).max(256) })).max(32), cursor: WIRE_TOKEN.nullable(), coverage: worldCoverage } },
  summary: "find_people: scoped label pages.",
};
