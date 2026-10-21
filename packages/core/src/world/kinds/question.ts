import { validateQuestionCard, type QuestionCard, type QuestionStatus } from "../../contracts/question-card";
import type { Relation } from "../../contracts/world-card-kit";
import { sealCard, type KindAssembler } from "./kit";

function asserted(relation: Relation): boolean {
  return relation.polarity === "positive" && relation.perspective.mode === "asserted";
}
function owner(relation: Relation): boolean {
  return relation.assessments.some(item => item.authority === "owner_correction" || item.authority === "owner_authored");
}
function lifecycle(statuses: readonly Relation[], answers: readonly Relation[]): QuestionCard["lifecycle"] {
  const explicit = statuses.filter(item => asserted(item) && owner(item) && item.object.kind === "vocabulary");
  const has = (status: QuestionStatus) => explicit.some(item => item.object.kind === "vocabulary" && item.object.id === `question/${status}`);
  const qualified = answers.filter(item => asserted(item) &&
    (owner(item) || item.assessments.filter(assessment => assessment.independence === "independent").length >= 2));
  const corroborated = qualified.filter(item => item.conflict === "none_observed");
  const opposed = answers.filter(item => item.conflict === "present");
  let status: QuestionStatus = "open";
  if (has("abandoned")) status = "abandoned";
  else if (has("reopened") || (has("resolved") && opposed.length > 0) || qualified.some(item => item.conflict === "present")) status = "reopened";
  else if (has("resolved")) status = "resolved";
  else if (has("partial")) status = "partial";
  else if (!has("open") && corroborated.length > 0) status = "resolved";
  const grounds = [...new Map([...explicit, ...corroborated, ...opposed].map(item => [item.claim.token, item.claim])).values()];
  return { status, grounds };
}

export const questionAssembler: KindAssembler = {
  kind: "question",
  assemble({ node, own, summary, coverage }) {
    const by = (predicate: string) => own.filter(item => item.predicate === predicate);
    const answers = by("question.candidate_answer"), statusEvidence = by("question.status");
    const card: QuestionCard = {
      schema: "kizuki.question-card/v1", question: { ...node, kind: "question" }, summary,
      texts: by("question.text"), answers, statusEvidence, about: by("gap.about"),
      motivations: by("question.motivates"), gaps: by("gap.kind"),
      lifecycle: lifecycle(statusEvidence, answers), understanding: "unknown",
      knownAt: { kind: "current" }, coverage,
    };
    return sealCard(card, validateQuestionCard, "question");
  },
};
