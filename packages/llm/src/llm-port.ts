import {
  LLM_CAPABILITIES,
  LLM_CONTRACT,
  LLM_CONTRACT_MINOR,
  PortError,
  isSecretRef,
  isPlainObject,
  validatePortDescriptor,
} from "@kizuki/core";
import type {
  LlmPort,
  LlmRequest,
  LlmResponse,
  PortContext,
  PortDescriptor,
  PortFactory,
  PortHealth,
} from "@kizuki/core";
import { configError } from "./errors";
import { readChatAnswer } from "./response";
import { fetchTransport } from "./transport";
import type {
  ChatMessage,
  ChatRequest,
  ChatTransport,
  TransportResult,
} from "./transport";

export const OPENAI_COMPATIBLE_LLM_ID = "kizuki.llm.openai-compatible";

export const OPENAI_COMPATIBLE_LLM: PortDescriptor = validatePortDescriptor({
  id: OPENAI_COMPATIBLE_LLM_ID,
  kind: "llm",
  contract: LLM_CONTRACT,
  contract_minor: LLM_CONTRACT_MINOR,
  supports: [...LLM_CAPABILITIES],
  requires_lease: false,
  optional_package: "@kizuki/llm",
});

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface LlmPortOverrides {
  transport?: ChatTransport;
  clock?: Clock;
}

const RATE_WINDOW_MS = 60_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;
const MAX_MESSAGES = 32;
const MAX_REQUEST_CHARS = 500_000;
const MAX_OUTPUT_TOKENS = 100_000;
const MAX_DEADLINE_MS = 600_000;
/** Four characters per token is the usual rough ratio for English prose. */
const CHARS_PER_TOKEN = 4;

const CONFIG_KEYS = new Set([
  "base_url",
  "model",
  "secret_ref",
  "timeout_ms",
  "max_retries",
  "requests_per_minute",
  "temperature",
  "json_mode",
  "max_response_bytes",
]);

interface NumberRule {
  min: number;
  max: number;
  fallback: number;
  integer: boolean;
}

const NUMBERS: Readonly<Record<string, NumberRule>> = {
  timeout_ms: {
    min: 1_000,
    max: MAX_DEADLINE_MS,
    fallback: 60_000,
    integer: true,
  },
  max_retries: { min: 0, max: 5, fallback: 2, integer: true },
  requests_per_minute: { min: 1, max: 600, fallback: 30, integer: true },
  temperature: { min: 0, max: 2, fallback: 0, integer: false },
  max_response_bytes: {
    min: 1_024,
    max: 8_388_608,
    fallback: 1_048_576,
    integer: true,
  },
};

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    (LOOPBACK_V4.test(hostname) &&
      hostname
        .split(".")
        .every((octet) => Number(octet) >= 0 && Number(octet) <= 255))
  );
}

export interface LlmPortConfig {
  base_url: string;
  model: string;
  secret_ref: string | null;
  timeout_ms: number;
  max_retries: number;
  requests_per_minute: number;
  temperature: number;
  json_mode: boolean;
  max_response_bytes: number;
}

function readNumber(config: Record<string, unknown>, key: string): number {
  const rule = NUMBERS[key];
  if (rule === undefined) configError(`ports.llm.${key} has no rule`);
  const raw = config[key];
  if (raw === undefined) return rule.fallback;
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    (rule.integer && !Number.isInteger(raw)) ||
    raw < rule.min ||
    raw > rule.max
  ) {
    configError(
      `ports.llm.${key} must be a number between ${rule.min} and ${rule.max}`,
    );
  }
  return raw;
}

/**
 * The owner's `[ports.llm]` table. Every key is named here; an unknown one is
 * refused rather than ignored, so a typo cannot silently disable a bound.
 */
export function readLlmPortConfig(
  config: Readonly<Record<string, unknown>>,
): LlmPortConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key))
      configError(`ports.llm.${key} is not a known key`);
  }

  const rawBase = config["base_url"];
  if (typeof rawBase !== "string" || rawBase.length === 0) {
    configError("ports.llm.base_url is required");
  }
  if (/[?#]/.test(rawBase)) {
    configError("ports.llm.base_url must not carry a query or fragment");
  }
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    configError("ports.llm.base_url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    configError("ports.llm.base_url scheme must be http or https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    configError("ports.llm.base_url must not carry userinfo");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    configError(
      "ports.llm.base_url must use https unless the endpoint is on loopback",
    );
  }

  const model = config["model"];
  if (typeof model !== "string" || model.length === 0 || model.length > 200) {
    configError("ports.llm.model is required and must be a short string");
  }

  const rawSecret = config["secret_ref"];
  if (rawSecret !== undefined && !isSecretRef(rawSecret)) {
    // The value is never echoed: a rejected secret_ref may be the key itself.
    configError(
      "ports.llm.secret_ref must be a secret reference (env:VAR or file:/abs/path)",
    );
  }

  const jsonMode = config["json_mode"];
  if (jsonMode !== undefined && typeof jsonMode !== "boolean") {
    configError("ports.llm.json_mode must be true or false");
  }

  return {
    base_url: rawBase.replace(/\/+$/, ""),
    model,
    secret_ref: rawSecret === undefined ? null : (rawSecret as string),
    timeout_ms: readNumber(config, "timeout_ms"),
    max_retries: readNumber(config, "max_retries"),
    requests_per_minute: readNumber(config, "requests_per_minute"),
    temperature: readNumber(config, "temperature"),
    json_mode: jsonMode ?? true,
    max_response_bytes: readNumber(config, "max_response_bytes"),
  };
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

/**
 * `kizuki.llm/v1` over an OpenAI-compatible chat-completions endpoint. It
 * holds the product's only network call site and resolves the owner's
 * credential through the host at call time, never storing or logging it.
 */
export class OpenAiCompatibleLlm implements LlmPort {
  readonly descriptor = OPENAI_COMPATIBLE_LLM;
  readonly config: LlmPortConfig;
  readonly url: string;

  private readonly context: PortContext;
  private readonly transport: ChatTransport;
  private readonly clock: Clock;
  private readonly window: number[] = [];
  private physicalAttempts = 0;
  private closed = false;

  constructor(context: PortContext, overrides: LlmPortOverrides = {}) {
    if (!isPlainObject(context.config)) {
      configError("ports.llm config must be a table");
    }
    this.context = context;
    this.config = readLlmPortConfig(context.config);
    this.url = `${this.config.base_url}/chat/completions`;
    this.transport = overrides.transport ?? fetchTransport;
    this.clock = overrides.clock ?? defaultClock;
  }

  /**
   * Physical requests this port has put on the wire, retries included, so a
   * host can see what a run really cost rather than what it logically asked
   * for. Bounded per call by `1 + max_retries`.
   */
  get attempts(): number {
    return this.physicalAttempts;
  }

  /** RFC 0002 §12.1: enough to answer "which model wrote this", no credential. */
  get model_ref(): string {
    return `${OPENAI_COMPATIBLE_LLM_ID}:${this.config.model}@${new URL(this.url).host}`;
  }

  async health(): Promise<PortHealth> {
    if (this.closed) {
      return { status: "unavailable", reason: "port is closed" };
    }
    if (this.config.secret_ref !== null) {
      try {
        await this.apiKey();
      } catch {
        return {
          status: "unavailable",
          reason: "the configured model credential could not be resolved",
        };
      }
    }
    return {
      status: "ready",
      detail: {
        host: new URL(this.url).host,
        model: this.config.model,
        authenticated: this.config.secret_ref !== null,
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (this.closed) {
      throw new PortError("unavailable", "port is closed", false);
    }
    const messages = this.validate(request);
    const timeout = Math.min(request.deadline_ms, this.config.timeout_ms);
    const chat: ChatRequest = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
      max_tokens: request.max_output_tokens,
      ...(this.config.json_mode
        ? { response_format: { type: "json_object" as const } }
        : {}),
    };

    let attempt = 0;
    for (;;) {
      const result = await this.send(chat, timeout);
      if (result.ok) {
        const answer = readChatAnswer(result.body);
        const inputChars = messages.reduce(
          (total, message) => total + message.content.length,
          0,
        );
        return {
          text: answer.text,
          model: answer.model ?? this.config.model,
          usage: {
            input_tokens: answer.input_tokens ?? estimateTokens(inputChars),
            output_tokens:
              answer.output_tokens ?? estimateTokens(answer.text.length),
          },
        };
      }
      const retryable =
        "retry_after_ms" in result && RETRY_STATUSES.has(result.status);
      if (!retryable || attempt >= this.config.max_retries) {
        throw this.transportError(result);
      }
      attempt += 1;
      await this.clock.sleep(
        Math.min(result.retry_after_ms ?? DEFAULT_RETRY_MS, MAX_RETRY_MS),
      );
    }
  }

  private validate(request: LlmRequest): ChatMessage[] {
    if (
      !Array.isArray(request.messages) ||
      request.messages.length === 0 ||
      request.messages.length > MAX_MESSAGES
    ) {
      configError("llm request must carry between 1 and 32 messages");
    }
    let chars = 0;
    const messages: ChatMessage[] = [];
    for (const message of request.messages) {
      if (
        !isPlainObject(message) ||
        typeof message.content !== "string" ||
        (message.role !== "system" &&
          message.role !== "user" &&
          message.role !== "assistant")
      ) {
        configError("llm request carries an invalid message");
      }
      chars += message.content.length;
      messages.push({ role: message.role, content: message.content });
    }
    if (chars > MAX_REQUEST_CHARS) {
      configError("llm request exceeds its character bound");
    }
    if (
      !Number.isInteger(request.max_output_tokens) ||
      request.max_output_tokens < 1 ||
      request.max_output_tokens > MAX_OUTPUT_TOKENS
    ) {
      configError("llm request max_output_tokens is out of range");
    }
    if (
      !Number.isInteger(request.deadline_ms) ||
      request.deadline_ms < 1 ||
      request.deadline_ms > MAX_DEADLINE_MS
    ) {
      configError("llm request deadline_ms is out of range");
    }
    return messages;
  }

  private async apiKey(): Promise<string | null> {
    if (this.config.secret_ref === null) return null;
    let value: string;
    try {
      value = await this.context.secrets(this.config.secret_ref);
    } catch (cause) {
      throw new PortError(
        "unavailable",
        "the configured model credential could not be resolved",
        false,
        { cause },
      );
    }
    if (value.length === 0 || value.length > 4_096 || /\s/.test(value)) {
      configError("the resolved model credential is not a usable header value");
    }
    return value;
  }

  /**
   * Sliding window over the configured rate. The wait is clamped to the
   * window so a backward clock step (an NTP correction, a resume from
   * suspend) cannot park a run for the size of the step.
   */
  private async send(
    request: ChatRequest,
    timeoutMs: number,
  ): Promise<TransportResult> {
    this.prune();
    const oldest = this.window[0];
    if (
      this.window.length >= this.config.requests_per_minute &&
      oldest !== undefined
    ) {
      const wait = oldest + RATE_WINDOW_MS - this.clock.now();
      await this.clock.sleep(Math.max(0, Math.min(wait, RATE_WINDOW_MS)));
      this.prune();
    }
    // Resolve the credential first: a request that fails closed here never
    // happened, so it must not consume a slot in the rate window either.
    const key = await this.apiKey();
    this.window.push(this.clock.now());
    this.physicalAttempts += 1;
    return await this.transport(request, {
      url: this.url,
      api_key: key,
      timeout_ms: timeoutMs,
      max_response_bytes: this.config.max_response_bytes,
    });
  }

  private prune(): void {
    const cutoff = this.clock.now() - RATE_WINDOW_MS;
    while (this.window.length > 0 && (this.window[0] ?? 0) <= cutoff) {
      this.window.shift();
    }
  }

  private transportError(result: TransportResult): PortError {
    const host = new URL(this.url).host;
    if ("failure" in result) {
      switch (result.failure) {
        case "timeout":
          return new PortError(
            "timeout",
            `${host} did not answer within its deadline`,
            true,
          );
        case "redirect":
          return new PortError(
            "unavailable",
            "the endpoint redirected; captured text is never sent to a second host",
            false,
          );
        case "too_large":
          return new PortError(
            "unavailable",
            `${host} answered with more than ${this.config.max_response_bytes} bytes`,
            false,
          );
        case "not_json":
          return new PortError(
            "unavailable",
            `${host} answered with a body that is not JSON`,
            false,
          );
        default:
          return new PortError(
            "unavailable",
            `${host} could not be reached`,
            true,
          );
      }
    }
    const status = "status" in result ? result.status : 0;
    if (status === 401 || status === 403) {
      return new PortError(
        "unavailable",
        `${host} refused the configured credential; check ports.llm.secret_ref`,
        false,
      );
    }
    return new PortError(
      "unavailable",
      `${host} answered ${status}`,
      RETRY_STATUSES.has(status),
    );
  }
}

export const openAiCompatibleLlm: PortFactory<LlmPort> = (ctx) =>
  new OpenAiCompatibleLlm(ctx);
