import type { LlmConfig } from "./config";
import { LlmError } from "./errors";
import { fetchTransport } from "./transport";
import type { ChatRequest, ChatTransport, TransportResult } from "./transport";

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface ChatClientOptions {
  config: LlmConfig;
  api_key: string | null;
  transport?: ChatTransport;
  clock?: Clock;
}

export interface ChatUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

export type ChatOutcome =
  | {
      ok: true;
      content: string;
      model: string | null;
      usage: ChatUsage;
      latency_ms: number;
    }
  | { ok: false; error: LlmError };

export interface ClientCounters {
  requests: number;
  input_chars: number;
  output_chars: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  errors: number;
}

const RATE_WINDOW_MS = 60_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_RETRY_MS = 2000;
const MAX_RETRY_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;

const KEY_HINT = "; set api_key with: kizuki llm set --api-key env:VAR";
const JSON_HINT =
  "; if the endpoint rejects response_format run: kizuki llm set --no-json-mode";

const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readContent(body: unknown): { content: string; model: string | null } {
  if (!isPlainRecord(body)) {
    throw new LlmError("bad_response", "the endpoint did not return an object");
  }
  const choices = body["choices"];
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = isPlainRecord(first) ? first["message"] : undefined;
  const content = isPlainRecord(message) ? message["content"] : undefined;
  if (typeof content !== "string") {
    throw new LlmError(
      "bad_response",
      "the endpoint returned no choices[0].message.content string",
    );
  }
  const model = body["model"];
  return { content, model: typeof model === "string" ? model : null };
}

function readUsage(body: unknown): ChatUsage {
  const usage = isPlainRecord(body) ? body["usage"] : undefined;
  if (!isPlainRecord(usage)) {
    return { prompt_tokens: null, completion_tokens: null };
  }
  return {
    prompt_tokens: integer(usage["prompt_tokens"]),
    completion_tokens: integer(usage["completion_tokens"]),
  };
}

/**
 * The owner's budget, rate limit and timeout live here rather than in the
 * transport, so every caller — including a future scheduler — is bounded by
 * the same numbers and cannot spend past them by choosing another entry point.
 */
export class ChatClient {
  readonly url: string;
  readonly counters: ClientCounters = {
    requests: 0,
    input_chars: 0,
    output_chars: 0,
    prompt_tokens: null,
    completion_tokens: null,
    errors: 0,
  };

  private readonly config: LlmConfig;
  private readonly apiKey: string | null;
  private readonly transport: ChatTransport;
  private readonly clock: Clock;
  private readonly window: number[] = [];

  constructor(opts: ChatClientOptions) {
    this.config = opts.config;
    this.apiKey = opts.api_key;
    this.transport = opts.transport ?? fetchTransport;
    this.clock = opts.clock ?? defaultClock;
    this.url = `${opts.config.base_url}/chat/completions`;
  }

  async complete(system: string, user: string): Promise<ChatOutcome> {
    try {
      this.assertBudget(user);
    } catch (error) {
      return this.failed(error);
    }
    this.counters.input_chars += user.length;

    const request: ChatRequest = {
      model: this.config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: this.config.temperature,
      max_tokens: this.config.max_output_tokens,
      ...(this.config.json_mode
        ? { response_format: { type: "json_object" as const } }
        : {}),
    };

    const startedAt = this.clock.now();
    try {
      let result = await this.send(request);
      if (
        result.ok === false &&
        "retry_after_ms" in result &&
        RETRY_STATUSES.has(result.status)
      ) {
        await this.clock.sleep(
          Math.min(result.retry_after_ms ?? DEFAULT_RETRY_MS, MAX_RETRY_MS),
        );
        result = await this.send(request);
      }
      if (result.ok !== true) throw this.transportError(result);

      const { content, model } = readContent(result.body);
      const usage = readUsage(result.body);
      this.counters.output_chars += content.length;
      if (usage.prompt_tokens !== null) {
        this.counters.prompt_tokens =
          (this.counters.prompt_tokens ?? 0) + usage.prompt_tokens;
      }
      if (usage.completion_tokens !== null) {
        this.counters.completion_tokens =
          (this.counters.completion_tokens ?? 0) + usage.completion_tokens;
      }
      return {
        ok: true,
        content,
        model,
        usage,
        latency_ms: this.clock.now() - startedAt,
      };
    } catch (error) {
      return this.failed(error);
    }
  }

  private assertBudget(user: string): void {
    if (this.counters.requests >= this.config.max_requests) {
      throw new LlmError(
        "budget_exhausted",
        `request budget of ${this.config.max_requests} requests is spent`,
      );
    }
    if (this.counters.input_chars + user.length > this.config.max_input_chars) {
      throw new LlmError(
        "budget_exhausted",
        `input budget of ${this.config.max_input_chars} characters is spent`,
      );
    }
  }

  /** Sliding window: a request waits for the oldest one to age out. */
  private async send(request: ChatRequest): Promise<TransportResult> {
    this.prune();
    const oldest = this.window[0];
    if (this.window.length >= this.config.requests_per_minute && oldest !== undefined) {
      await this.clock.sleep(oldest + RATE_WINDOW_MS - this.clock.now());
      this.prune();
    }
    this.window.push(this.clock.now());
    this.counters.requests += 1;
    return await this.transport(request, {
      url: this.url,
      api_key: this.apiKey,
      timeout_ms: this.config.timeout_ms,
      max_response_bytes: MAX_RESPONSE_BYTES,
    });
  }

  private prune(): void {
    const cutoff = this.clock.now() - RATE_WINDOW_MS;
    while (this.window.length > 0 && (this.window[0] ?? 0) <= cutoff) {
      this.window.shift();
    }
  }

  private transportError(result: TransportResult): LlmError {
    if ("failure" in result) {
      switch (result.failure) {
        case "timeout":
          return new LlmError(
            "timeout",
            `the endpoint did not answer within ${this.config.timeout_ms} ms`,
          );
        case "network":
          return new LlmError(
            "network",
            `the endpoint at ${new URL(this.url).host} could not be reached`,
          );
        case "redirect":
          return new LlmError(
            "redirect",
            "the endpoint redirected; captured text is never sent to a second host",
          );
        case "too_large":
          return new LlmError(
            "response_too_large",
            `the endpoint returned more than ${MAX_RESPONSE_BYTES} bytes`,
          );
        default:
          return new LlmError(
            "bad_response",
            "the endpoint returned a body that is not JSON",
          );
      }
    }
    const status = "status" in result ? result.status : 0;
    const hint =
      status === 401 || status === 403
        ? KEY_HINT
        : status === 400 && this.config.json_mode
          ? JSON_HINT
          : "";
    return new LlmError(
      "http_error",
      `the endpoint answered ${status}${hint}`,
      status,
    );
  }

  private failed(error: unknown): ChatOutcome {
    if (!(error instanceof LlmError)) throw error;
    this.counters.errors += 1;
    return { ok: false, error };
  }
}
