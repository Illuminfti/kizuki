/**
 * A test-only card for a kind that does not ship, built from the card kit to
 * show what a new kind costs: its shape, the validator of each field, and an
 * assembler. Everything else is the kit and the pipeline.
 */
import {
  cardCodec,
  coverage,
  knownAt,
  knowledgeNode,
  optionalRelation,
  relationList,
  summary,
  type CardKnownAt,
  type CardSummary,
  type Coverage,
  type KnowledgeNode,
  type Relation,
} from "../../src/contracts/world-card-kit";
import { sealCard, type KindAssembler } from "../../src/world/kinds/kit";

export const QUESTION_CARD_SCHEMA = "kizuki.question-card/v1" as const;

export type QuestionCard = {
  readonly schema: typeof QUESTION_CARD_SCHEMA;
  readonly question: KnowledgeNode<"question">;
  readonly summary: CardSummary | null;
  readonly text: Relation | null;
  readonly answers: readonly Relation[];
  readonly knownAt: CardKnownAt;
  readonly coverage: Coverage;
};

export const validateQuestionCard = cardCodec<QuestionCard, "question-card">({
  schema: QUESTION_CARD_SCHEMA,
  label: "question-card",
  fields: {
    question: (value) => knowledgeNode(value, "question"),
    summary,
    text: optionalRelation,
    answers: relationList,
    knownAt,
    coverage,
  },
});

export const questionAssembler: KindAssembler = {
  kind: "question",
  assemble({ node, own, summary, coverage }) {
    const texts = own.filter((item) => item.predicate === "question.text");
    const card: QuestionCard = {
      schema: QUESTION_CARD_SCHEMA,
      question: { ...node, kind: "question" },
      summary,
      text: texts.length === 1 ? texts[0]! : null,
      answers: own.filter((item) => item.predicate === "question.candidate_answer"),
      knownAt: { kind: "current" },
      coverage,
    };
    return sealCard(card, validateQuestionCard, "question");
  },
};
