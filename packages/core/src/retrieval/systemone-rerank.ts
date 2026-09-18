import type { Sensitivity } from "../agents/types";
import { PortError } from "../contracts/ports";
import type {
  SystemOneChoiceQuestion,
  SystemOnePort,
  SystemOneQuestion,
} from "../contracts/systemone";
import { isNonEmptyString, isPlainObject } from "../util/validate";

/** One noul per candidate plus the capture-level sensitivity choice. */
export const MAX_RERANK_CANDIDATES = 63;

export const RETRIEVAL_SENSITIVITY_QUESTION_ID = "sensitivity" as const;

export const RETRIEVAL_SENSITIVITY_CHOICE_CRITERIA: Readonly<
  Record<string, string | null>
> = Object.freeze({
  secret:
    "Credentials, tokens, private keys, or material that must never be retrieved.",
  sensitive:
    "Private household or family facts; map to private on the Kizuki lattice.",
  public: "Already public, or intended to be public.",
  personal: "Identifying personal context that is not secret.",
});

const CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_QUERY_CHARS = 4_000;
const MAX_CANDIDATE_TEXT_CHARS = 2_000;

export interface SystemOneRerankCandidate {
  readonly id: string;
  readonly text: string;
}

export interface SystemOneRankedCandidate extends SystemOneRerankCandidate {
  readonly noul: number;
}

export interface SystemOneRerankSensitivity {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
  /** Null is outside the lattice and must never be served. */
  readonly mapped: Sensitivity | null;
}

export type SystemOneRerankResult =
  | {
      readonly status: "ok";
      readonly reranked: true;
      readonly ranked: readonly SystemOneRankedCandidate[];
      readonly served: readonly SystemOneRankedCandidate[];
      readonly sensitivity: SystemOneRerankSensitivity;
    }
  | {
      readonly status: "ok";
      readonly reranked: false;
      readonly ranked: readonly SystemOneRerankCandidate[];
      readonly served: readonly SystemOneRerankCandidate[];
      readonly sensitivity: null;
    }
  | { readonly status: "unavailable"; readonly reason: string }
  | {
      readonly status: "rejected";
      readonly reason: "schema_invalid" | "choice_criteria";
    };

export interface RerankWithSystemOneInput {
  readonly query: string;
  readonly candidates: readonly SystemOneRerankCandidate[];
  readonly port: SystemOnePort | undefined;
  readonly deadline_ms: number;
}

function requestError(message: string): never {
  throw new PortError("config_invalid", message, false);
}

/**
 * Choice criteria must be a dict `Record<string, string | null>`, never an
 * array. Used by the retrieval consumer before `evaluate()`.
 */
export function validateChoiceCriteriaDict(
  criteria: unknown,
): Readonly<Record<string, string | null>> {
  if (!isPlainObject(criteria)) {
    requestError("choice criteria must be an object");
  }
  const keys = Object.keys(criteria);
  if (keys.length < 2 || keys.length > 255) {
    requestError("choice criteria must have between 2 and 255 options");
  }
  const out: Record<string, string | null> = {};
  for (const key of keys) {
    if (!isNonEmptyString(key) || key.length > 128) {
      requestError("choice option ids must be bounded strings");
    }
    const value = criteria[key];
    if (value !== null && (!isNonEmptyString(value) || value.length > 4_000)) {
      requestError("choice option descriptions must be null or bounded strings");
    }
    out[key] = value;
  }
  return out;
}

export function mapSystemOneSensitivityChoice(
  choice: string,
): Sensitivity | null {
  if (choice === "sensitive") return "private";
  if (choice === "public") return "public";
  if (choice === "personal") return "personal";
  return null;
}

function noulQuestionId(id: string): string {
  return `noul:${id}`;
}

function classifyError(error: unknown): SystemOneRerankResult {
  if (error instanceof PortError) {
    if (error.code === "unavailable" || error.code === "timeout") {
      return { status: "unavailable", reason: error.message };
    }
    if (error.message === "choice criteria must be an object") {
      return { status: "rejected", reason: "choice_criteria" };
    }
    if (error.message.startsWith("rejected:") || error.code === "config_invalid") {
      return { status: "rejected", reason: "schema_invalid" };
    }
  }
  return { status: "unavailable", reason: "systemone unavailable" };
}

function boundText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function buildSensitivityQuestion(): SystemOneChoiceQuestion {
  const criteria = validateChoiceCriteriaDict(RETRIEVAL_SENSITIVITY_CHOICE_CRITERIA);
  return {
    type: "choice",
    instructions:
      "Classify the sensitivity of this capture and its candidates as a whole.",
    criteria,
  };
}

/**
 * Optional System One rerank after an FTS5 / embedding shortlist.
 * Unconfigured ports keep the shortlist order. A configured but dead port is
 * unavailable, never a silent empty success. Unlabeled / secret / unknown
 * sensitivity is never served.
 */
export async function rerankWithSystemOne(
  input: RerankWithSystemOneInput,
): Promise<SystemOneRerankResult> {
  const { query, candidates, port, deadline_ms } = input;
  if (!isNonEmptyString(query) || query.length > MAX_QUERY_CHARS) {
    return { status: "rejected", reason: "schema_invalid" };
  }
  if (
    typeof deadline_ms !== "number" ||
    !Number.isSafeInteger(deadline_ms) ||
    deadline_ms < 1
  ) {
    return { status: "rejected", reason: "schema_invalid" };
  }
  if (candidates.length > MAX_RERANK_CANDIDATES) {
    return { status: "rejected", reason: "schema_invalid" };
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!CANDIDATE_ID.test(candidate.id) || seen.has(candidate.id)) {
      return { status: "rejected", reason: "schema_invalid" };
    }
    if (typeof candidate.text !== "string") {
      return { status: "rejected", reason: "schema_invalid" };
    }
    seen.add(candidate.id);
  }

  if (port === undefined || port.model_ref === null || candidates.length === 0) {
    return {
      status: "ok",
      reranked: false,
      ranked: [...candidates],
      served: [...candidates],
      sensitivity: null,
    };
  }

  let sensitivityQuestion: SystemOneChoiceQuestion;
  try {
    sensitivityQuestion = buildSensitivityQuestion();
  } catch (error) {
    return classifyError(error);
  }

  const questions: Record<string, SystemOneQuestion> = {
    [RETRIEVAL_SENSITIVITY_QUESTION_ID]: sensitivityQuestion,
  };
  for (const candidate of candidates) {
    questions[noulQuestionId(candidate.id)] = {
      type: "noul",
      instructions: `Is candidate ${candidate.id} relevant to the query?`,
      criteria: {
        true: "The candidate answers or materially supports the query",
        false: "The candidate is unrelated or only weakly related",
      },
    };
  }

  let response;
  try {
    response = await port.evaluate({
      state: {
        query: boundText(query, MAX_QUERY_CHARS),
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          text: boundText(candidate.text, MAX_CANDIDATE_TEXT_CHARS),
        })),
      },
      questions,
      deadline_ms,
    });
  } catch (error) {
    return classifyError(error);
  }

  const scored: SystemOneRankedCandidate[] = [];
  const originalIndex = new Map<string, number>();
  for (const [index, candidate] of candidates.entries()) {
    originalIndex.set(candidate.id, index);
    const answer = response.answers[noulQuestionId(candidate.id)];
    if (answer === undefined || answer.type !== "noul") {
      return { status: "rejected", reason: "schema_invalid" };
    }
    if (
      typeof answer.noul !== "number" ||
      !Number.isFinite(answer.noul) ||
      answer.noul < 0 ||
      answer.noul > 1
    ) {
      return { status: "rejected", reason: "schema_invalid" };
    }
    scored.push({ id: candidate.id, text: candidate.text, noul: answer.noul });
  }

  scored.sort((left, right) => {
    if (right.noul !== left.noul) return right.noul - left.noul;
    return (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0);
  });

  const choiceAnswer = response.answers[RETRIEVAL_SENSITIVITY_QUESTION_ID];
  if (choiceAnswer === undefined || choiceAnswer.type !== "choice") {
    return { status: "rejected", reason: "schema_invalid" };
  }
  const optionIds = Object.keys(sensitivityQuestion.criteria);
  if (
    !isNonEmptyString(choiceAnswer.choice) ||
    !optionIds.includes(choiceAnswer.choice)
  ) {
    return { status: "rejected", reason: "schema_invalid" };
  }
  if (!isPlainObject(choiceAnswer.probabilities)) {
    return { status: "rejected", reason: "schema_invalid" };
  }
  for (const option of optionIds) {
    const probability = choiceAnswer.probabilities[option];
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      return { status: "rejected", reason: "schema_invalid" };
    }
  }
  if (
    typeof choiceAnswer.confidence !== "number" ||
    !Number.isFinite(choiceAnswer.confidence) ||
    choiceAnswer.confidence < 0 ||
    choiceAnswer.confidence > 1
  ) {
    return { status: "rejected", reason: "schema_invalid" };
  }

  const mapped = mapSystemOneSensitivityChoice(choiceAnswer.choice);
  const sensitivity: SystemOneRerankSensitivity = {
    choice: choiceAnswer.choice,
    confidence: choiceAnswer.confidence,
    probabilities: choiceAnswer.probabilities,
    mapped,
  };
  return {
    status: "ok",
    reranked: true,
    ranked: scored,
    served: mapped === null ? [] : scored,
    sensitivity,
  };
}
