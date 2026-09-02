import {
  PortError,
  isNonEmptyString,
  isPlainObject,
  isSecretRef,
} from "@kizuki/core";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MAX_RETRIES = 8;

export interface OpenAiCompatibleLlmConfig {
  readonly base_url: string;
  readonly model: string;
  readonly secret_ref: string | null;
  readonly timeout_ms: number;
  readonly max_retries: number;
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

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    return true;
  }
  const dotted = host.startsWith("::ffff:") ? host.slice(7) : host;
  const parts = dotted.split(".");
  if (parts.length !== 4) return false;
  if (parts[0] !== "127") return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

export function endpointHost(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.hostname;
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export function modelRef(portId: string, model: string, host: string): string {
  return `${portId}:${model}@${host}`;
}

function parseUrl(value: unknown): URL {
  if (!isNonEmptyString(value)) {
    configError("base_url is required");
  }
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
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
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
  if (value === undefined) return DEFAULT_MAX_RETRIES;
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

export function parseOpenAiCompatibleConfig(
  value: unknown,
): OpenAiCompatibleLlmConfig {
  if (!isPlainObject(value)) {
    configError("llm config must be a table");
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      configError(`unknown llm config key ${key}`);
    }
  }

  const url = parseUrl(value["base_url"]);
  if (!isNonEmptyString(value["model"])) {
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
    model: value["model"],
    secret_ref: typeof secret === "string" ? secret : null,
    timeout_ms: parseTimeout(value["timeout_ms"]),
    max_retries: parseRetries(value["max_retries"]),
  };
}
