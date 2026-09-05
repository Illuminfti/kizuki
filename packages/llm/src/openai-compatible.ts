import {
  LLM_CAPABILITIES,
  LLM_CONTRACT,
  LLM_CONTRACT_MINOR,
  PortError,
  isNonEmptyString,
  validatePortDescriptor,
} from "@kizuki/core";
import type {
  LlmMessage,
  LlmPort,
  LlmRequest,
  LlmResponse,
  PortContext,
  PortDescriptor,
  PortHealth,
} from "@kizuki/core";
import {
  chatCompletionsUrl,
  endpointHost,
  modelRef,
  parseOpenAiCompatibleConfig,
} from "./config";
import type { OpenAiCompatibleLlmConfig } from "./config";
import { isRetryableStatus, parseChatCompletion } from "./response";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  fetchTransport,
} from "./transport";
import type { ChatTransport, TransportResult } from "./transport";

export const OPENAI_COMPATIBLE_LLM_ID =
  "kizuki.llm.openai-compatible" as const;

export const OPENAI_COMPATIBLE_LLM_DESCRIPTOR: PortDescriptor =
  validatePortDescriptor({
    id: OPENAI_COMPATIBLE_LLM_ID,
    kind: "llm",
    contract: LLM_CONTRACT,
    contract_minor: LLM_CONTRACT_MINOR,
    supports: LLM_CAPABILITIES,
    requires_lease: false,
    optional_package: null,
  });

export interface OpenAiCompatibleOptions {
  readonly transport?: ChatTransport;
}

const ROLES = new Set(["system", "user", "assistant"]);
const MAX_MESSAGES = 32;
const MAX_CONTENT_CHARS = 400_000;
const MAX_OUTPUT_TOKENS = 16_384;
const RETRY_CAP_MS = 30_000;
const DEFAULT_RETRY_MS = 2_000;

function requestError(message: string): never {
  throw new PortError("config_invalid", message, false);
}

function validateMessages(
  messages: readonly LlmMessage[],
): readonly LlmMessage[] {
  if (messages.length === 0 || messages.length > MAX_MESSAGES) {
    requestError("messages must be a bounded non-empty list");
  }
  return messages.map((message) => {
    if (!ROLES.has(message.role) || typeof message.content !== "string") {
      requestError("each message must have a role and string content");
    }
    if (message.content.length > MAX_CONTENT_CHARS) {
      requestError("message content exceeds the input bound");
    }
    return { role: message.role, content: message.content };
  });
}

function validateRequest(request: LlmRequest): {
  messages: readonly LlmMessage[];
  max_output_tokens: number;
  deadline_ms: number;
} {
  if (
    typeof request.max_output_tokens !== "number" ||
    !Number.isSafeInteger(request.max_output_tokens) ||
    request.max_output_tokens < 1 ||
    request.max_output_tokens > MAX_OUTPUT_TOKENS
  ) {
    requestError("max_output_tokens is out of range");
  }
  if (
    typeof request.deadline_ms !== "number" ||
    !Number.isSafeInteger(request.deadline_ms) ||
    request.deadline_ms < 1
  ) {
    requestError("deadline_ms is out of range");
  }
  return {
    messages: validateMessages(request.messages),
    max_output_tokens: request.max_output_tokens,
    deadline_ms: request.deadline_ms,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(): PortError {
  return new PortError("timeout", "model request timed out", true);
}

/** Keep the caller's one deadline authoritative, including injected transports. */
async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), remaining);
    work.then(
      (value) => {
        clearTimeout(timer);
        // A nonconforming transport may resolve after its timeout. Never
        // accept that late success merely because its timer ran first.
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

function transportToError(result: Extract<TransportResult, { ok: false }>): never {
  if (result.kind === "transport") {
    if (result.failure === "timeout") {
      throw new PortError("timeout", "model request timed out", true);
    }
    if (result.failure === "too_large") {
      throw new PortError("unavailable", "rejected: response_too_large", false);
    }
    if (result.failure === "not_json") {
      throw new PortError("unavailable", "rejected: bad_response", false);
    }
    throw new PortError("unavailable", `model ${result.failure}`, result.failure === "network");
  }
  throw new PortError("unavailable", `http ${result.status}`, isRetryableStatus(result.status));
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
    throw new PortError(
      "unavailable",
      "secret reference did not resolve",
      false,
    );
  }
  if (!isNonEmptyString(value)) {
    throw new PortError(
      "unavailable",
      "secret reference did not resolve",
      false,
    );
  }
  return value;
}

function buildWireBody(
  config: OpenAiCompatibleLlmConfig,
  request: { messages: readonly LlmMessage[]; max_output_tokens: number },
): Record<string, unknown> {
  return {
    model: config.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    max_tokens: request.max_output_tokens,
  };
}

export function createOpenAiCompatibleLlmPort(
  ctx: PortContext,
  options: OpenAiCompatibleOptions = {},
): LlmPort {
  const config = parseOpenAiCompatibleConfig(ctx.config);
  const transport = options.transport ?? fetchTransport;
  const host = endpointHost(config.base_url);
  const ref = modelRef(OPENAI_COMPATIBLE_LLM_ID, config.model, host);
  const url = chatCompletionsUrl(config.base_url);
  let closed = false;

  const assertOpen = (): void => {
    if (closed) {
      throw new PortError("unavailable", "llm port is closed", false);
    }
  };

  return {
    descriptor: OPENAI_COMPATIBLE_LLM_DESCRIPTOR,
    model_ref: ref,
    async health(): Promise<PortHealth> {
      if (closed) {
        return { status: "unavailable", reason: "llm port is closed" };
      }
      return { status: "ready", detail: { model_ref: ref, host } };
    },
    async complete(request: LlmRequest): Promise<LlmResponse> {
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
        last = await beforeDeadline(transport({
          url,
          api_key: apiKey,
          timeout_ms: remaining,
          max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
          body,
        }), deadline);
        if (last.ok) {
          return parseChatCompletion(last.body, config.model);
        }
        const retryable =
          last.kind === "transport"
            ? last.failure === "timeout" || last.failure === "network"
            : isRetryableStatus(last.status);
        if (!retryable || attempt === config.max_retries) {
          transportToError(last);
        }
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
        throw new PortError("unavailable", "model unavailable", true);
      }
      transportToError(last);
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}
