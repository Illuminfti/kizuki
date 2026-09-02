import { isSecretRef } from "@kizuki/core";
import { configError } from "./errors";

/** Bounds every knob so a misconfigured port cannot outspend its owner. */
export const MAX_DEADLINE_MS = 600_000;

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
