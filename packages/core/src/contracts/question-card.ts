import { isPlainObject } from "../util/validate";
import {
  cardCodec, coverage, exact, knownAt, knowledgeNode, relationList, summary, wireRef,
  type CardKnownAt, type CardSummary, type Coverage, type KnowledgeNode, type Relation, type WorldWireRef,
} from "./world-card-kit";

export const QUESTION_CARD_SCHEMA = "kizuki.question-card/v1" as const;
export type QuestionStatus = "open" | "partial" | "resolved" | "reopened" | "abandoned";
export type QuestionCard = {
  readonly schema: typeof QUESTION_CARD_SCHEMA;
  readonly question: KnowledgeNode<"question">;
  readonly summary: CardSummary | null;
  readonly texts: readonly Relation[];
  readonly answers: readonly Relation[];
  readonly statusEvidence: readonly Relation[];
  readonly about: readonly Relation[];
  readonly motivations: readonly Relation[];
  readonly gaps: readonly Relation[];
  readonly lifecycle: { readonly status: QuestionStatus; readonly grounds: readonly WorldWireRef<"claim">[] };
  /** An available answer or resolved question is not evidence of understanding. */
  readonly understanding: "unknown";
  readonly knownAt: CardKnownAt;
  readonly coverage: Coverage;
};

export const validateQuestionCard = cardCodec<QuestionCard, "question-card">({
  schema: QUESTION_CARD_SCHEMA, label: "question-card",
  fields: {
    question: value => knowledgeNode(value, "question"), summary,
    texts: relationList, answers: relationList, statusEvidence: relationList,
    about: relationList, motivations: relationList, gaps: relationList,
    lifecycle: value => isPlainObject(value) && exact(value, ["status", "grounds"]) &&
      typeof value.status === "string" && ["open", "partial", "resolved", "reopened", "abandoned"].includes(value.status) &&
      Array.isArray(value.grounds) && value.grounds.length <= 256 && value.grounds.every(ref => wireRef(ref, "claim")),
    understanding: value => value === "unknown", knownAt, coverage,
  },
});
