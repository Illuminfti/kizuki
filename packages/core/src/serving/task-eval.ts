import { packetPrefix, packetTokens } from "./packet-tokenizer";

/** #496 case for one matched budget. Not a serving tool and not a score. */
export const TASK_EVAL_CASE = "task-context-matched-budget" as const;

export const TASK_EVAL_ARMS = ["plain_history", "lexical_current", "candidate"] as const;

export type TaskEvalArmName = (typeof TASK_EVAL_ARMS)[number];

const MIN_BUDGET = 50;
const MAX_BUDGET = 2_000;
const MAX_LABEL = 200;
const MAX_TEXT = 32_000;
const MAX_BYTES = 2_000_000;
const MAX_MS = 120_000;

export class TaskEvalError extends Error {
  readonly code: "unmatched" | "upstream_score" | "unsupported";

  constructor(code: TaskEvalError["code"], message: string) {
    super(message);
    this.name = "TaskEvalError";
    this.code = code;
  }
}

export type TaskEvalArmInput = {
  readonly name: TaskEvalArmName;
  readonly budget_tokens: number;
  readonly served_text: string;
  readonly loaded_bytes: number;
  readonly recovered_text: string | null;
  readonly elapsed_ms: number;
};

export type TaskEvalObservation = {
  readonly name: TaskEvalArmName;
  readonly completion: boolean;
  readonly evidence_recovery: boolean;
  readonly reconstruction_burden_bytes: number;
  readonly obsolete_assumption_reuse: boolean;
  readonly latency_ms: number;
  readonly processing_tokens: number;
  readonly model: "unrun";
};

export type TaskEvalReport = {
  readonly case_id: typeof TASK_EVAL_CASE;
  readonly budget_tokens: number;
  readonly model: "unrun";
  readonly upstream_score: "not_inherited";
  readonly improvement_claim: "none";
  readonly outcome: "observed";
  readonly arms: readonly TaskEvalObservation[];
};

type ReportInput = {
  readonly constraint: string;
  readonly omitted_identifier: string;
  readonly superseded: string;
  readonly arms: readonly TaskEvalArmInput[];
};

function refuse(code: TaskEvalError["code"], message: string): never {
  throw new TaskEvalError(code, message);
}

function assertBudget(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_BUDGET || value > MAX_BUDGET) {
    refuse("unsupported", "budget is outside the packet bound");
  }
  return value;
}

function label(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LABEL || value.includes("\u0000")) {
    refuse("unsupported", `${name} is not a bounded label`);
  }
  return value;
}

function textOf(name: string, value: unknown, allowNull: boolean): string | null {
  if (value === null && allowNull) return null;
  if (typeof value !== "string" || value.length > MAX_TEXT || value.includes("\u0000")) {
    refuse("unsupported", `${name} is not bounded text`);
  }
  return value;
}

function countOf(name: string, value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    refuse("unsupported", `${name} is not a bounded count`);
  }
  return value;
}

function forbidScore(value: object): void {
  for (const key of ["upstream_score", "winner", "improvement", "score"]) {
    if (key in value) refuse("upstream_score", "an inherited score is not an observation");
  }
}

/** Longest prefix whose packet-token count fits. This is the plain-history baseline, not a packet. */
export function fitPlainHistory(text: string, budgetTokens: number): string {
  const budget = assertBudget(budgetTokens);
  const body = textOf("history", text, false) ?? "";
  return packetPrefix(body, budget);
}

function reusesObsolete(served: string, superseded: string): boolean {
  if (!served.includes(superseded)) return false;
  let marked = false;
  let unmarked = false;
  for (const line of served.split("\n")) {
    if (!line.includes(superseded)) continue;
    if (line.startsWith("rejected: ")) marked = true;
    else unmarked = true;
  }
  if (unmarked) return true;
  if (marked) return false;
  return true;
}

function observe(arm: TaskEvalArmInput, constraint: string, omitted: string, superseded: string): TaskEvalObservation {
  const served = textOf("served_text", arm.served_text, false);
  const recovered = textOf("recovered_text", arm.recovered_text, true);
  if (served === null) refuse("unsupported", "served_text is not bounded text");
  const recoveredText = recovered ?? "";
  return {
    name: arm.name,
    completion: served.includes(constraint),
    evidence_recovery: served.includes(omitted) || recoveredText.includes(omitted),
    reconstruction_burden_bytes: countOf("loaded_bytes", arm.loaded_bytes, MAX_BYTES),
    obsolete_assumption_reuse: reusesObsolete(served, superseded),
    latency_ms: countOf("elapsed_ms", arm.elapsed_ms, MAX_MS),
    processing_tokens: packetTokens(served) + packetTokens(recoveredText),
    model: "unrun",
  };
}

/**
 * Record three arms at one budget. The report observes completion, recovery,
 * burden, stale reuse, latency and token cost. It does not rank a winner.
 */
export function reportTaskEval(input: ReportInput): TaskEvalReport {
  forbidScore(input);
  const constraint = label("constraint", input.constraint);
  const omitted = label("omitted_identifier", input.omitted_identifier);
  const superseded = label("superseded", input.superseded);
  if (constraint === omitted || constraint === superseded || omitted === superseded) {
    refuse("unsupported", "the three labels must be distinct");
  }
  if (!Array.isArray(input.arms) || input.arms.length !== TASK_EVAL_ARMS.length) {
    refuse("unmatched", "the comparison needs the three named arms");
  }
  const byName = new Map<TaskEvalArmName, TaskEvalArmInput>();
  for (const arm of input.arms) {
    forbidScore(arm);
    if (!TASK_EVAL_ARMS.includes(arm.name) || byName.has(arm.name)) {
      refuse("unmatched", "each arm is named once");
    }
    byName.set(arm.name, arm);
  }
  const arms = TASK_EVAL_ARMS.map((name) => {
    const arm = byName.get(name);
    if (arm === undefined) refuse("unmatched", "each arm is named once");
    return arm;
  });
  const budget = assertBudget(arms[0]?.budget_tokens);
  for (const arm of arms) {
    if (assertBudget(arm.budget_tokens) !== budget) {
      refuse("unmatched", "arms must share one budget");
    }
  }
  return {
    case_id: TASK_EVAL_CASE,
    budget_tokens: budget,
    model: "unrun",
    upstream_score: "not_inherited",
    improvement_claim: "none",
    outcome: "observed",
    arms: arms.map((arm) => observe(arm, constraint, omitted, superseded)),
  };
}
