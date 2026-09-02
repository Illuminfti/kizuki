import {
  LLM_CAPABILITIES,
  LLM_CONTRACT,
  PortError,
  isPlainObject,
  validatePortDescriptor,
} from "@kizuki/core";
import type {
  LlmPort,
  LlmRequest,
  LlmResponse,
  LlmSpend,
  PortContext,
  PortDescriptor,
  PortFactory,
  PortHealth,
} from "@kizuki/core";
import { MAX_DEADLINE_MS, readLlmPortConfig } from "./config";
import type { LlmPortConfig } from "./config";
import { LlmFailure, configError, refusedAfter } from "./errors";
import { readChatAnswer } from "./response";
import type { ProviderAnswer } from "./response";
import { RateWindow, defaultClock } from "./rate";
import type { Clock } from "./rate";
import {
  NOTHING_SPENT,
  answeredSpend,
  estimateTokens,
  unansweredSpend,
} from "./spend";
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
  // The minor this implementation provides, written out rather than read
  // from the contract, so a later additive field cannot inflate it.
  contract_minor: 1,
  supports: [...LLM_CAPABILITIES],
  // The implementation lives in a workspace package a distribution can leave
  // out, and core cannot import it, so a host is told which package to have.
  optional_package: "@kizuki/llm",
  requires_lease: false,
});

export interface LlmPortOverrides {
  transport?: ChatTransport;
  clock?: Clock;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;
const MAX_MESSAGES = 32;
const MAX_REQUEST_CHARS = 500_000;
const MAX_OUTPUT_TOKENS = 100_000;

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
  private readonly rate: RateWindow;
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
    this.rate = new RateWindow(this.clock, this.config.requests_per_minute);
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
    // The caller's allowance never widens this port's own retry bound; it
    // only narrows it, so a spend budget above cannot be outrun from here.
    const allowance = Math.min(
      request.max_attempts ?? Number.MAX_SAFE_INTEGER,
      1 + this.config.max_retries,
    );
    // One deadline for the whole call. A retry that cannot finish inside it is
    // not a retry, it is an overrun no scheduler above this port can plan for.
    const deadline = this.clock.now() + request.deadline_ms;
    const chat: ChatRequest = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
      max_tokens: request.max_output_tokens,
      ...(this.config.json_mode
        ? { response_format: { type: "json_object" as const } }
        : {}),
    };

    const inputChars = messages.reduce(
      (total, message) => total + message.content.length,
      0,
    );

    let used = 0;
    for (;;) {
      if (this.clock.now() >= deadline) {
        throw this.deadlineError(unansweredSpend(used, inputChars));
      }
      const result = await this.send(chat, deadline, used, inputChars);
      used += 1;
      if (result.ok) {
        let answer: ProviderAnswer;
        try {
          answer = readChatAnswer(result.body);
        } catch (error) {
          // A refused answer still cost what the endpoint served to produce
          // it, so the refusal carries the spend rather than dropping it.
          throw refusedAfter(error, answeredSpend(null, used, inputChars));
        }
        const spend = answeredSpend(answer, used, inputChars);
        return {
          text: answer.text,
          model: answer.model ?? this.config.model,
          usage: {
            input_tokens: spend.input_tokens,
            output_tokens: spend.output_tokens,
          },
          attempts: used,
        };
      }
      const spend = unansweredSpend(used, inputChars);
      const retryable =
        "retry_after_ms" in result && RETRY_STATUSES.has(result.status);
      if (!retryable || used >= allowance) {
        throw this.transportError(result, spend);
      }
      const wait = Math.min(
        result.retry_after_ms ?? DEFAULT_RETRY_MS,
        MAX_RETRY_MS,
      );
      if (this.clock.now() + wait >= deadline) {
        throw this.transportError(result, spend);
      }
      await this.clock.sleep(wait);
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
      request.max_attempts !== undefined &&
      (!Number.isInteger(request.max_attempts) || request.max_attempts < 1)
    ) {
      configError("llm request max_attempts must be a whole number above zero");
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

  private async apiKey(spend: LlmSpend = NOTHING_SPENT): Promise<string | null> {
    if (this.config.secret_ref === null) return null;
    let value: string;
    try {
      value = await this.context.secrets(this.config.secret_ref);
    } catch (cause) {
      throw new LlmFailure(
        "unavailable",
        "the configured model credential could not be resolved",
        false,
        spend,
        { cause },
      );
    }
    if (value.length === 0 || value.length > 4_096 || /\s/.test(value)) {
      configError("the resolved model credential is not a usable header value");
    }
    return value;
  }

  private async send(
    request: ChatRequest,
    deadline: number,
    used: number,
    inputChars: number,
  ): Promise<TransportResult> {
    const spend = unansweredSpend(used, inputChars);
    const slot = await this.rate.take(deadline);
    if (slot === null) throw this.deadlineError(spend);
    let key: string | null;
    try {
      key = await this.apiKey(spend);
    } catch (error) {
      // A request that fails closed here never happened, so it must not keep
      // a slot in the rate window either.
      this.rate.release(slot);
      throw error;
    }
    const remaining = deadline - this.clock.now();
    if (remaining <= 0) {
      this.rate.release(slot);
      throw this.deadlineError(spend);
    }
    this.physicalAttempts += 1;
    return await this.transport(request, {
      url: this.url,
      api_key: key,
      timeout_ms: Math.min(remaining, this.config.timeout_ms),
      max_response_bytes: this.config.max_response_bytes,
    });
  }

  private deadlineError(spend: LlmSpend): PortError {
    return new LlmFailure(
      "timeout",
      `${new URL(this.url).host} did not answer within its deadline`,
      true,
      spend,
    );
  }

  private transportError(result: TransportResult, spend: LlmSpend): PortError {
    const host = new URL(this.url).host;
    const failed = (
      code: "timeout" | "unavailable",
      message: string,
      retryable: boolean,
    ): PortError => new LlmFailure(code, message, retryable, spend);
    if ("failure" in result) {
      switch (result.failure) {
        case "timeout":
          return failed(
            "timeout",
            `${host} did not answer within its deadline`,
            true,
          );
        case "redirect":
          return failed(
            "unavailable",
            "the endpoint redirected; captured text is never sent to a second host",
            false,
          );
        case "too_large":
          return failed(
            "unavailable",
            `${host} answered with more than ${this.config.max_response_bytes} bytes`,
            false,
          );
        case "not_json":
          return failed(
            "unavailable",
            `${host} answered with a body that is not JSON`,
            false,
          );
        default:
          return failed("unavailable", `${host} could not be reached`, true);
      }
    }
    const status = "status" in result ? result.status : 0;
    if (status === 401 || status === 403) {
      return failed(
        "unavailable",
        `${host} refused the configured credential; check ports.llm.secret_ref`,
        false,
      );
    }
    return failed(
      "unavailable",
      `${host} answered ${status}`,
      RETRY_STATUSES.has(status),
    );
  }
}

export const openAiCompatibleLlm: PortFactory<LlmPort> = (ctx) =>
  new OpenAiCompatibleLlm(ctx);
