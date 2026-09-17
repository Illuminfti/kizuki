import type { Port } from "./ports";

export const SYSTEMONE_CONTRACT = "kizuki.systemone/v1" as const;
export const SYSTEMONE_CONTRACT_MINOR = 0;
export const SYSTEMONE_CAPABILITIES = ["evaluate"] as const;
export type SystemOneCapability = (typeof SYSTEMONE_CAPABILITIES)[number];

export const SYSTEMONE_QUESTION_TYPES = ["noul", "choice", "score"] as const;
export type SystemOneQuestionType = (typeof SYSTEMONE_QUESTION_TYPES)[number];

export const SYSTEMONE_ADMIT_NOUL_MIN = 0.3;

export type SystemOneState = string | Readonly<Record<string, unknown>> | readonly unknown[];

export type SystemOneNoulQuestion = {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: {
    readonly true?: string;
    readonly false?: string;
  };
};

export type SystemOneChoiceQuestion = {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>>;
};

export type SystemOneScoreQuestion = {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: readonly string[];
};

export type SystemOneQuestion =
  | SystemOneNoulQuestion
  | SystemOneChoiceQuestion
  | SystemOneScoreQuestion;

export type SystemOneNoulAnswer = {
  readonly type: "noul";
  readonly noul: number;
};

export type SystemOneChoiceAnswer = {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};

export type SystemOneScoreAnswer = {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};

export type SystemOneAnswer =
  | SystemOneNoulAnswer
  | SystemOneChoiceAnswer
  | SystemOneScoreAnswer;

export interface SystemOneUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface SystemOneRequest {
  readonly state: SystemOneState;
  readonly questions: Readonly<Record<string, SystemOneQuestion>>;
  readonly deadline_ms: number;
}

export interface SystemOneResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, SystemOneAnswer>>;
  readonly usage: SystemOneUsage;
}

export interface SystemOnePort extends Port {
  readonly model_ref: string | null;
  evaluate(request: SystemOneRequest): Promise<SystemOneResponse>;
}
