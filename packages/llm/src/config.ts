import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  SENSITIVITY_ORDER,
  isPlainObject,
  parseSecretRef,
  ulid,
} from "@kizuki/core";
import type { Sensitivity } from "@kizuki/core";
import { LlmError } from "./errors";

export const LLM_CONFIG_PATH = ".kizuki/llm.toml" as const;
export const UNLABELED_MODES = ["skip", "send"] as const;
export type UnlabeledMode = (typeof UNLABELED_MODES)[number];

export interface LlmConfig {
  base_url: string;
  model: string;
  api_key_ref: string | null;
  allow_cloud_inference: boolean;
  sensitivity_ceiling: Sensitivity;
  unlabeled: UnlabeledMode;
  json_mode: boolean;
  temperature: number;
  timeout_ms: number;
  requests_per_minute: number;
  max_requests: number;
  max_input_chars: number;
  max_event_chars: number;
  max_output_tokens: number;
  summary_min_chars: number;
}

export type LlmConfigDefaults = Omit<
  LlmConfig,
  "base_url" | "model" | "api_key_ref"
>;

export const LLM_CONFIG_DEFAULTS: LlmConfigDefaults = {
  allow_cloud_inference: false,
  sensitivity_ceiling: "personal",
  unlabeled: "skip",
  json_mode: true,
  temperature: 0,
  timeout_ms: 60000,
  requests_per_minute: 30,
  max_requests: 60,
  max_input_chars: 400000,
  max_event_chars: 8000,
  max_output_tokens: 1024,
  summary_min_chars: 280,
};

type NumberKey =
  | "temperature"
  | "timeout_ms"
  | "requests_per_minute"
  | "max_requests"
  | "max_input_chars"
  | "max_event_chars"
  | "max_output_tokens"
  | "summary_min_chars";

interface NumberRule {
  key: NumberKey;
  min: number;
  max: number;
  integer: boolean;
}

const NUMBER_RULES: readonly NumberRule[] = [
  { key: "temperature", min: 0, max: 2, integer: false },
  { key: "timeout_ms", min: 1000, max: 600000, integer: true },
  { key: "requests_per_minute", min: 1, max: 600, integer: true },
  { key: "max_requests", min: 1, max: 10000, integer: true },
  { key: "max_input_chars", min: 1, max: 100000000, integer: true },
  { key: "max_event_chars", min: 1, max: 1000000, integer: true },
  { key: "max_output_tokens", min: 1, max: 1000000, integer: true },
  { key: "summary_min_chars", min: 0, max: 1000000, integer: true },
];

const KEYS = [
  "base_url",
  "model",
  "api_key",
  "allow_cloud_inference",
  "sensitivity_ceiling",
  "unlabeled",
  "json_mode",
  ...NUMBER_RULES.map((rule) => rule.key),
] as const;

const SENSITIVITIES = Object.keys(SENSITIVITY_ORDER) as Sensitivity[];
const LOOPBACK_V4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") {
    return true;
  }
  const match = LOOPBACK_V4.exec(hostname);
  return (
    match !== null && match.slice(1).every((octet) => Number(octet) <= 255)
  );
}

export function isLoopbackUrl(base_url: string): boolean {
  try {
    return isLoopbackHostname(new URL(base_url).hostname);
  } catch {
    return false;
  }
}

/** Host and port only: what receipts and doctor may print about an endpoint. */
export function endpointHost(base_url: string): string {
  return new URL(base_url).host;
}

function parseBaseUrl(raw: unknown): { normalized: string; url: URL } {
  if (raw === undefined) throw new LlmError("bad_base_url", "base_url: required");
  if (typeof raw !== "string") {
    throw new LlmError("bad_base_url", "base_url: must be a string");
  }
  if (/[?#]/.test(raw)) {
    throw new LlmError(
      "bad_base_url",
      "base_url: must not carry a query or fragment",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LlmError("bad_base_url", "base_url: not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LlmError("bad_base_url", "base_url: scheme must be http or https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new LlmError("bad_base_url", "base_url: must not carry userinfo");
  }
  return { normalized: raw.replace(/\/+$/, ""), url };
}

/** The value is never echoed: a rejected api_key may be the key itself. */
function parseApiKeyRef(raw: unknown): string | null {
  if (raw === undefined) return null;
  const ref = parseSecretRef(raw);
  if (ref === null) {
    throw new LlmError(
      "plaintext_key",
      "api_key must be a secret reference (env:VAR or file:/abs/path); never paste the key into llm.toml",
    );
  }
  if (ref.scheme === "file" && !ref.value.startsWith("/")) {
    throw new LlmError(
      "bad_secret_ref",
      "api_key file: reference must be an absolute path",
    );
  }
  return raw as string;
}

function readBoolean(
  table: Record<string, unknown>,
  key: "allow_cloud_inference" | "json_mode",
): boolean {
  const raw = table[key];
  if (raw === undefined) return LLM_CONFIG_DEFAULTS[key];
  if (typeof raw !== "boolean") {
    throw new LlmError("bad_value", `${key}: must be true or false`);
  }
  return raw;
}

function readChoice<T extends string>(
  table: Record<string, unknown>,
  key: string,
  choices: readonly T[],
  fallback: T,
): T {
  const raw = table[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !(choices as readonly string[]).includes(raw)) {
    throw new LlmError(
      "bad_value",
      `${key}: must be one of ${choices.join(" | ")}`,
    );
  }
  return raw as T;
}

function readNumber(table: Record<string, unknown>, rule: NumberRule): number {
  const raw = table[rule.key];
  if (raw === undefined) return LLM_CONFIG_DEFAULTS[rule.key];
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    (rule.integer && !Number.isInteger(raw)) ||
    raw < rule.min ||
    raw > rule.max
  ) {
    const kind = rule.integer ? "an integer" : "a number";
    throw new LlmError(
      "bad_value",
      `${rule.key}: must be ${kind} between ${rule.min} and ${rule.max}`,
    );
  }
  return raw;
}

/** The single validation path: every reader and writer goes through here. */
export function parseLlmConfig(text: string): LlmConfig {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    throw new LlmError("malformed_config", "llm.toml: invalid TOML");
  }
  if (!isPlainObject(parsed)) {
    throw new LlmError("malformed_config", "llm.toml: must be a flat table");
  }
  for (const key of Object.keys(parsed)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      throw new LlmError("unknown_key", `llm.toml: unknown key ${key}`);
    }
    if (isPlainObject(parsed[key])) {
      throw new LlmError(
        "unknown_key",
        `llm.toml: [${key}] tables are not supported; use flat keys`,
      );
    }
  }

  const base = parseBaseUrl(parsed["base_url"]);
  const model = parsed["model"];
  if (typeof model !== "string" || model.length === 0) {
    throw new LlmError("bad_value", "model: must be a non-empty string");
  }
  const numbers = {} as Record<NumberKey, number>;
  for (const rule of NUMBER_RULES) numbers[rule.key] = readNumber(parsed, rule);

  const config: LlmConfig = {
    base_url: base.normalized,
    model,
    api_key_ref: parseApiKeyRef(parsed["api_key"]),
    allow_cloud_inference: readBoolean(parsed, "allow_cloud_inference"),
    sensitivity_ceiling: readChoice(
      parsed,
      "sensitivity_ceiling",
      SENSITIVITIES,
      LLM_CONFIG_DEFAULTS.sensitivity_ceiling,
    ),
    unlabeled: readChoice(
      parsed,
      "unlabeled",
      UNLABELED_MODES,
      LLM_CONFIG_DEFAULTS.unlabeled,
    ),
    json_mode: readBoolean(parsed, "json_mode"),
    ...numbers,
  };

  if (!isLoopbackHostname(base.url.hostname)) {
    if (!config.allow_cloud_inference) {
      throw new LlmError(
        "cloud_not_allowed",
        `base_url ${base.url.host} is not loopback; set allow_cloud_inference = true to send captured text to it`,
      );
    }
    if (base.url.protocol === "http:") {
      throw new LlmError(
        "insecure_remote",
        `base_url ${base.url.host} is not loopback and uses http; https is required off the local machine`,
      );
    }
  }
  return config;
}

export function serializeLlmConfig(config: LlmConfig): string {
  const lines = [
    `base_url = ${JSON.stringify(config.base_url)}`,
    `model = ${JSON.stringify(config.model)}`,
  ];
  if (config.api_key_ref !== null) {
    lines.push(`api_key = ${JSON.stringify(config.api_key_ref)}`);
  }
  lines.push(
    `allow_cloud_inference = ${config.allow_cloud_inference}`,
    `sensitivity_ceiling = ${JSON.stringify(config.sensitivity_ceiling)}`,
    `unlabeled = ${JSON.stringify(config.unlabeled)}`,
    `json_mode = ${config.json_mode}`,
  );
  for (const rule of NUMBER_RULES) {
    lines.push(`${rule.key} = ${String(config[rule.key])}`);
  }
  return `${lines.join("\n")}\n`;
}

/** `null` means the file is absent: the vault has no model endpoint. */
export function readLlmConfig(vaultPath: string): LlmConfig | null {
  const path = join(vaultPath, LLM_CONFIG_PATH);
  if (!existsSync(path)) return null;
  return parseLlmConfig(readFileSync(path, "utf8"));
}

function writeAll(fd: number, text: string): void {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
  }
}

/**
 * Owner-only file, written whole under a temporary name and renamed into
 * place, so a crash leaves either the previous file or the new one. The
 * serialized text is re-parsed first: an invalid config is never persisted.
 */
export function writeLlmConfig(vaultPath: string, config: LlmConfig): string {
  const text = serializeLlmConfig(config);
  parseLlmConfig(text);
  const finalPath = resolve(vaultPath, LLM_CONFIG_PATH);
  mkdirSync(dirname(finalPath), { recursive: true });
  const temporary = `${finalPath}.${ulid()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeAll(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, finalPath);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  return finalPath;
}

export function removeLlmConfig(vaultPath: string): boolean {
  const path = join(vaultPath, LLM_CONFIG_PATH);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
