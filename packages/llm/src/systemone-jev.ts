import {
  PortError,
  SYSTEMONE_CAPABILITIES,
  SYSTEMONE_CONTRACT,
  SYSTEMONE_CONTRACT_MINOR,
  isNonEmptyString,
  isPlainObject,
  isSecretRef,
  validatePortDescriptor,
} from "@kizuki/core";
import type {
  PortContext,
  PortDescriptor,
  PortHealth,
  SystemOneAnswer,
  SystemOneChoiceAnswer,
  SystemOneChoiceQuestion,
  SystemOneNoulAnswer,
  SystemOnePort,
  SystemOneQuestion,
  SystemOneRequest,
  SystemOneResponse,
  SystemOneScoreAnswer,
  SystemOneScoreQuestion,
  SystemOneUsage,
} from "@kizuki/core";
import { endpointHost, modelRef } from "./config";
import { isRetryableStatus } from "./response";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  fetchTransport,
} from "./transport";
import type { ChatTransport, TransportResult } from "./transport";

export const SYSTEMONE_JEV_ID = "kizuki.systemone.jev" as const;
export const DEFAULT_SYSTEMONE_BASE_URL = "https://api.typesafe.ai/v1";
export const DEFAULT_SYSTEMONE_MODEL = "jev-latest";
export const DEFAULT_SYSTEMONE_TIMEOUT_MS = 30_000;
export const DEFAULT_SYSTEMONE_MAX_RETRIES = 2;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RETRIES = 8;
const MAX_QUESTIONS = 64;
const MAX_INSTRUCTIONS_CHARS = 8_000;
const MAX_CRITERIA = 255;
const MAX_CRITERIA_CHARS = 4_000;
const RETRY_CAP_MS = 30_000;
const DEFAULT_RETRY_MS = 2_000;

export const SYSTEMONE_JEV_DESCRIPTOR: PortDescriptor = validatePortDescriptor({
  id: SYSTEMONE_JEV_ID,
  kind: "systemone",
  contract: SYSTEMONE_CONTRACT,
  contract_minor: SYSTEMONE_CONTRACT_MINOR,
  supports: SYSTEMONE_CAPABILITIES,
  requires_lease: false,
  optional_package: null,
});

export interface SystemOneJevConfig {
  readonly base_url: string;
  readonly model: string;
  readonly secret_ref: string | null;
  readonly timeout_ms: number;
  readonly max_retries: number;
}

export interface SystemOneJevOptions {
  readonly transport?: ChatTransport;
}

const ALLOWED_KEYS = new Set([
  "base_url",
  "model",
  "secret_ref",
  "timeout_ms",
  "max_retries",
]);

function configError(message: string): never {
  throw new PortError("config_invalid", message, false);
}

function requestError(message: string): never {
  throw new PortError("config_invalid", message, false);
}

export function systemOneUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/systemone`;
}

function parseUrl(value: unknown, required: boolean): URL {
  if (value === undefined) {
    if (!required) return new URL(DEFAULT_SYSTEMONE_BASE_URL);
    configError("base_url is required");
  }
  if (!isNonEmptyString(value)) configError("base_url is required");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    configError("base_url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    configError("base_url must be http or https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    configError("base_url must not include userinfo");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    configError("base_url must not include a query or fragment");
  }
  return url;
}

function parseTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_SYSTEMONE_TIMEOUT_MS;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MIN_TIMEOUT_MS ||
    value > MAX_TIMEOUT_MS
  ) {
    configError("timeout_ms is out of range");
  }
  return value;
}

function parseRetries(value: unknown): number {
  if (value === undefined) return DEFAULT_SYSTEMONE_MAX_RETRIES;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_RETRIES
  ) {
    configError("max_retries is out of range");
  }
  return value;
}

export function parseSystemOneJevConfig(value: unknown): SystemOneJevConfig {
  if (!isPlainObject(value)) configError("systemone config must be a table");
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) configError(`unknown systemone config key ${key}`);
  }
  const url = parseUrl(value["base_url"], false);
  const model = value["model"];
  if (model !== undefined && !isNonEmptyString(model)) {
    configError("model is required");
  }
  const secret = value["secret_ref"];
  if (secret !== undefined && secret !== null) {
    if (typeof secret !== "string" || !isSecretRef(secret)) {
      configError(
        "secret_ref must be a secret reference (env:VAR or file:/abs/path); never paste the key into config",
      );
    }
  }
  return {
    base_url: url.href.replace(/\/+$/, ""),
    model: isNonEmptyString(model) ? model : DEFAULT_SYSTEMONE_MODEL,
    secret_ref: typeof secret === "string" ? secret : null,
    timeout_ms: parseTimeout(value["timeout_ms"]),
    max_retries: parseRetries(value["max_retries"]),
  };
}

function timeoutError(): PortError {
  return new PortError("timeout", "systemone request timed out", true);
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), remaining);
    work.then(
      (value) => {
        clearTimeout(timer);
        if (Date.now() >= deadline) reject(timeoutError());
        else resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transportToError(result: Extract<TransportResult, { ok: false }>): never {
  if (result.kind === "transport") {
    if (result.failure === "timeout") {
      throw new PortError("timeout", "systemone request timed out", true);
    }
    if (result.failure === "too_large") {
      throw new PortError("unavailable", "rejected: response_too_large", false);
    }
    if (result.failure === "not_json") {
      throw new PortError("unavailable", "rejected: bad_response", false);
    }
    throw new PortError(
      "unavailable",
      `systemone ${result.failure}`,
      result.failure === "network",
    );
  }
  throw new PortError(
    "unavailable",
    `http ${result.status}`,
    isRetryableStatus(result.status),
  );
}

async function resolveApiKey(
  ctx: PortContext,
  secretRef: string | null,
): Promise<string | null> {
  if (secretRef === null) return null;
  let value: string;
  try {
    value = await ctx.secrets(secretRef);
  } catch {
    throw new PortError("unavailable", "secret reference did not resolve", false);
  }
  if (!isNonEmptyString(value)) {
    throw new PortError("unavailable", "secret reference did not resolve", false);
  }
  return value;
}

function validateQuestion(id: string, question: SystemOneQuestion): SystemOneQuestion {
  if (!isNonEmptyString(id) || id.length > 128) {
    requestError("question ids must be bounded non-empty strings");
  }
  if (!isNonEmptyString(question.instructions) || question.instructions.length > MAX_INSTRUCTIONS_CHARS) {
    requestError("question instructions must be a bounded string");
  }
  if (question.type === "noul") {
    const criteria = question.criteria;
    if (criteria === undefined) {
      return { type: "noul", instructions: question.instructions };
    }
    if (!isPlainObject(criteria)) requestError("noul criteria must be an object");
    for (const key of Object.keys(criteria)) {
      if (key !== "true" && key !== "false") requestError("noul criteria keys are true and false");
      const value = criteria[key as "true" | "false"];
      if (value !== undefined && (!isNonEmptyString(value) || value.length > MAX_CRITERIA_CHARS)) {
        requestError("noul criteria values must be bounded strings");
      }
    }
    return { type: "noul", instructions: question.instructions, criteria };
  }
  if (question.type === "choice") {
    if (!isPlainObject(question.criteria)) {
      requestError("choice criteria must be an object");
    }
    const entries = Object.entries(question.criteria);
    if (entries.length < 2 || entries.length > MAX_CRITERIA) {
      requestError("choice criteria must have between 2 and 255 options");
    }
    const criteria: Record<string, string | null> = {};
    for (const [key, value] of entries) {
      if (!isNonEmptyString(key) || key.length > 128) {
        requestError("choice option ids must be bounded strings");
      }
      if (value !== null && (!isNonEmptyString(value) || value.length > MAX_CRITERIA_CHARS)) {
        requestError("choice option descriptions must be null or bounded strings");
      }
      criteria[key] = value;
    }
    return { type: "choice", instructions: question.instructions, criteria };
  }
  if (question.type !== "score") requestError("question type must be noul, choice, or score");
  if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > MAX_CRITERIA) {
    requestError("score criteria must have between 2 and 255 levels");
  }
  const criteria = question.criteria.map((level) => {
    if (!isNonEmptyString(level) || level.length > MAX_CRITERIA_CHARS) {
      requestError("score levels must be bounded strings");
    }
    return level;
  });
  return { type: "score", instructions: question.instructions, criteria };
}

function validateRequest(request: SystemOneRequest): SystemOneRequest {
  if (
    typeof request.deadline_ms !== "number" ||
    !Number.isSafeInteger(request.deadline_ms) ||
    request.deadline_ms < 1
  ) {
    requestError("deadline_ms is out of range");
  }
  const ids = Object.keys(request.questions);
  if (ids.length === 0 || ids.length > MAX_QUESTIONS) {
    requestError("questions must be a bounded non-empty map");
  }
  const questions: Record<string, SystemOneQuestion> = {};
  for (const id of ids) {
    questions[id] = validateQuestion(id, request.questions[id]!);
  }
  return {
    state: request.state,
    questions,
    deadline_ms: request.deadline_ms,
  };
}

function unitInterval(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function probabilityMap(
  value: unknown,
  expected: readonly string[],
): Record<string, number> | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== expected.length) return null;
  const out: Record<string, number> = {};
  let total = 0;
  for (const key of expected) {
    const probability = unitInterval(value[key]);
    if (probability === null) return null;
    out[key] = probability;
    total += probability;
  }
  if (Math.abs(total - 1) > 0.02) return null;
  return out;
}

function parseNoul(body: Record<string, unknown>): SystemOneNoulAnswer | null {
  const noul = unitInterval(body["noul"]);
  if (noul === null) return null;
  return { type: "noul", noul };
}

function parseChoice(
  body: Record<string, unknown>,
  question: SystemOneChoiceQuestion,
): SystemOneChoiceAnswer | null {
  const options = Object.keys(question.criteria);
  const choice = body["choice"];
  if (typeof choice !== "string" || !options.includes(choice)) return null;
  const probabilities = probabilityMap(body["probabilities"], options);
  const confidence = unitInterval(body["confidence"]);
  if (probabilities === null || confidence === null) return null;
  return { type: "choice", choice, probabilities, confidence };
}

function parseScore(
  body: Record<string, unknown>,
  question: SystemOneScoreQuestion,
): SystemOneScoreAnswer | null {
  const score = body["score"];
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  const levels = question.criteria.map((_, index) => String(index));
  const probabilities = probabilityMap(body["probabilities"], levels);
  const confidence = unitInterval(body["confidence"]);
  const legendRaw = body["legend"];
  if (probabilities === null || confidence === null || !isPlainObject(legendRaw)) return null;
  const legend: Record<string, string> = {};
  for (const [index, description] of question.criteria.entries()) {
    const key = String(index);
    const listed = legendRaw[key];
    if (typeof listed !== "string" || listed !== description) return null;
    legend[key] = listed;
  }
  return { type: "score", score, legend, probabilities, confidence };
}

function parseAnswer(
  body: unknown,
  question: SystemOneQuestion,
): SystemOneAnswer | null {
  if (!isPlainObject(body) || body["type"] !== question.type) return null;
  if (question.type === "noul") return parseNoul(body);
  if (question.type === "choice") return parseChoice(body, question);
  return parseScore(body, question);
}

function parseUsage(value: unknown): SystemOneUsage {
  if (!isPlainObject(value)) return { input_tokens: 0, output_tokens: 0 };
  const input =
    typeof value["input_tokens"] === "number" && Number.isSafeInteger(value["input_tokens"]) && value["input_tokens"] >= 0
      ? value["input_tokens"]
      : 0;
  const output =
    typeof value["output_tokens"] === "number" && Number.isSafeInteger(value["output_tokens"]) && value["output_tokens"] >= 0
      ? value["output_tokens"]
      : 0;
  return { input_tokens: input, output_tokens: output };
}

export function parseSystemOneResponse(
  body: unknown,
  questions: Readonly<Record<string, SystemOneQuestion>>,
  fallbackModel: string,
): SystemOneResponse {
  if (!isPlainObject(body)) {
    throw new PortError("unavailable", "rejected: bad_response", false);
  }
  const answersRaw = body["answers"];
  if (!isPlainObject(answersRaw)) {
    throw new PortError("unavailable", "rejected: bad_response", false);
  }
  const expected = Object.keys(questions);
  if (Object.keys(answersRaw).length !== expected.length) {
    throw new PortError("unavailable", "rejected: bad_response", false);
  }
  const answers: Record<string, SystemOneAnswer> = {};
  for (const id of expected) {
    const parsed = parseAnswer(answersRaw[id], questions[id]!);
    if (parsed === null) {
      throw new PortError("unavailable", "rejected: bad_response", false);
    }
    answers[id] = parsed;
  }
  const model =
    typeof body["model"] === "string" && body["model"].length > 0
      ? body["model"]
      : fallbackModel;
  return { model, answers, usage: parseUsage(body["usage"]) };
}

function buildWireBody(
  config: SystemOneJevConfig,
  request: SystemOneRequest,
): Record<string, unknown> {
  return {
    model: config.model,
    state: request.state,
    questions: request.questions,
  };
}

export function createSystemOneJevPort(
  ctx: PortContext,
  options: SystemOneJevOptions = {},
): SystemOnePort {
  const config = parseSystemOneJevConfig(ctx.config);
  const transport = options.transport ?? fetchTransport;
  const host = endpointHost(config.base_url);
  const ref = modelRef(SYSTEMONE_JEV_ID, config.model, host);
  const url = systemOneUrl(config.base_url);
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new PortError("unavailable", "systemone port is closed", false);
  };

  return {
    descriptor: SYSTEMONE_JEV_DESCRIPTOR,
    model_ref: ref,
    async health(): Promise<PortHealth> {
      if (closed) return { status: "unavailable", reason: "systemone port is closed" };
      return { status: "ready", detail: { model_ref: ref, host } };
    },
    async evaluate(request: SystemOneRequest): Promise<SystemOneResponse> {
      assertOpen();
      const validated = validateRequest(request);
      const deadline = Date.now() + Math.min(config.timeout_ms, validated.deadline_ms);
      const apiKey = await beforeDeadline(resolveApiKey(ctx, config.secret_ref), deadline);
      const body = buildWireBody(config, validated);
      let attempt = 0;
      let last: TransportResult | undefined;
      while (attempt <= config.max_retries) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timeoutError();
        last = await beforeDeadline(
          transport({
            url,
            api_key: apiKey,
            timeout_ms: remaining,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            body,
          }),
          deadline,
        );
        if (last.ok) {
          return parseSystemOneResponse(last.body, validated.questions, config.model);
        }
        const retryable =
          last.kind === "transport"
            ? last.failure === "timeout" || last.failure === "network"
            : isRetryableStatus(last.status);
        if (!retryable || attempt === config.max_retries) transportToError(last);
        const wait =
          last.kind === "transport"
            ? DEFAULT_RETRY_MS
            : Math.min(last.retry_after_ms ?? DEFAULT_RETRY_MS, RETRY_CAP_MS);
        const remainingBeforeWait = deadline - Date.now();
        if (remainingBeforeWait <= 0) throw timeoutError();
        await beforeDeadline(sleep(Math.min(wait, remainingBeforeWait)), deadline);
        attempt += 1;
      }
      if (last === undefined || last.ok) {
        throw new PortError("unavailable", "systemone unavailable", true);
      }
      transportToError(last);
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}
