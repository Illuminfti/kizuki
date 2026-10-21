import { z } from "zod";
import { CURSOR, LABEL, WIRE_TOKEN, WORLD_OBJECT_REF, worldCommon, worldCoverage, worldNode, worldRef, worldRelation } from "./shared";
import type { McpWorldOp } from "./types";

export const ABOUT = WORLD_OBJECT_REF.optional();
const QUERY = { label: LABEL, cursor: CURSOR, about: ABOUT };
const relations = z.array(worldRelation).max(256);
export const questionFragment: McpWorldOp = {
  name: "question", fields: { question: WORLD_OBJECT_REF.optional() },
  data: { "kizuki.question-card/v1": {
    question: worldNode("question"), ...worldCommon,
    texts: relations, answers: relations, statusEvidence: relations, about: relations, motivations: relations, gaps: relations,
    lifecycle: z.strictObject({ status: z.enum(["open", "partial", "resolved", "reopened", "abandoned"]), grounds: z.array(worldRef("claim")).max(256) }),
    understanding: z.literal("unknown"),
  } },
  summary: "question: attributed answers/lifecycle; resolution is not understanding.",
};
export const findQuestionsFragment: McpWorldOp = {
  name: "find_questions", fields: QUERY,
  data: { "kizuki.question-matches/v1": {
    matches: z.array(z.strictObject({ ref: WORLD_OBJECT_REF, labels: z.array(z.string().max(400)).max(256) })).max(32),
    cursor: WIRE_TOKEN.nullable(), coverage: worldCoverage,
  } },
  summary: "find_questions: label/about pages.",
};
export const frontierFragment: McpWorldOp = {
  name: "frontier", fields: QUERY,
  data: { "kizuki.frontier/v1": {
    groups: z.array(z.strictObject({
      kind: z.enum(["missing_prerequisite", "unresolved_question", "contradiction", "stale_evidence", "misconception", "lack_of_practice", "missing_information"]),
      questions: z.array(WORLD_OBJECT_REF).max(32),
    })).max(7), cursor: WIRE_TOKEN.nullable(), coverage: worldCoverage,
  } },
  summary: "frontier: grouped gaps; unfinished extraction stays partial.",
};
