import { anchorOf, WORLD_DISCOVERY_SCAN_BUDGET } from "../pipeline/collect";
import { newReadFrame, type ReadFrame } from "../pipeline/frame";
import { readWorldMatches } from "../pipeline/read";
import { resolveWorldObject } from "../references";
import { NOT_FOUND, coveredOutcome } from "./outcome";
import { isWorldWireToken, parseWorldRef } from "./parse";
import { WorldViewError, type ClaimsOp, type WorldObjectRef } from "./types";

export interface QuestionQuery { readonly label: string; readonly cursor: string | null; readonly about: WorldObjectRef | null }
export function parseQuestionQuery(input: Record<string, unknown>): QuestionQuery | null {
  const label = Object.hasOwn(input, "label") ? input.label : "";
  let cursor: string | null = null;
  if (Object.hasOwn(input, "cursor")) {
    if (typeof input.cursor !== "string" || !isWorldWireToken(input.cursor)) return null;
    cursor = input.cursor;
  }
  const about = Object.hasOwn(input, "about") ? parseWorldRef(input.about, "object") : null;
  if (typeof label !== "string" || label.length > 200 ||
      (Object.hasOwn(input, "about") && about === null)) return null;
  return { label, cursor, about };
}
export function questionMatches(frame: ReadFrame, query: QuestionQuery) {
  const { ctx, ns } = frame;
  const after = query.cursor === null ? null : resolveWorldObject(ctx.db, ns, query.cursor);
  if (query.cursor !== null && after === null) throw new WorldViewError();
  const handle = query.about === null ? null : resolveWorldObject(ctx.db, ns, query.about.token);
  const about = handle === null ? null : anchorOf(ctx.db, handle);
  if (query.about !== null && about === null) return null;
  return readWorldMatches(frame, "question", query.label, after, WORLD_DISCOVERY_SCAN_BUDGET,
    about === null ? undefined : { predicate: "gap.about", object: about });
}
export const findQuestionsOp: ClaimsOp<QuestionQuery> = {
  source: "claims", name: "find_questions", keys: { required: [], optional: ["label", "cursor", "about"] },
  dataSchemas: ["kizuki.question-matches/v1"], views: true, parse: parseQuestionQuery,
  run: ({ ctx, ns, dependencies }, query, { valid }) => {
    const matches = questionMatches(newReadFrame(ctx, ns, valid, dependencies), query);
    return matches === null ? NOT_FOUND : coveredOutcome(matches);
  },
};
