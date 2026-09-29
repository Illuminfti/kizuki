import {
  DECLARED_RETENTION_CLASSES,
  PortError,
  isNonEmptyString,
  isPlainObject,
  isSecretRef,
  type DeclaredRetention,
} from "@kizuki/core";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MAX_RETRIES = 8;
/** OpenAI's chat-completions `reasoning_effort` values; providers support subsets. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Routing controls passed through, unchanged, as the request's `provider`
 * object. OpenAI-compatible routers that understand it (OpenRouter is the
 * reference) use it to refuse providers that log prompts or lack zero data
 * retention. Kizuki forwards these; the router enforces them.
 */
export interface ProviderPrivacy {
  readonly data_collection?: "allow" | "deny";
  readonly zdr?: boolean;
  readonly allow_fallbacks?: boolean;
  readonly order?: readonly string[];
  readonly only?: readonly string[];
  readonly ignore?: readonly string[];
}

const PROVIDER_LISTS = ["order", "only", "ignore"] as const;
const PROVIDER_KEYS = new Set<string>(["data_collection", "zdr", "allow_fallbacks", ...PROVIDER_LISTS]);
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,63}$/;
const MAX_PROVIDER_LIST = 32;

/**
 * What the owner declares the destination does with the text, never inferred. Source consent compares
 * it with the class a grant accepts, and an undeclared destination counts as the loosest.
 */
export type LlmRetentionClass = DeclaredRetention;

export interface OpenAiCompatibleLlmConfig {
  readonly base_url: string;
  readonly model: string;
  readonly secret_ref: string | null;
  readonly timeout_ms: number;
  readonly max_retries: number;
  /** Sent only when configured; absent leaves reasoning to the provider's default. */
  readonly reasoning_effort: ReasoningEffort | null;
  /** Sent only when configured; absent leaves provider routing to the router's default. */
  readonly provider?: ProviderPrivacy;
  /** Sent only when configured. Extraction wants 0: provider defaults vary the JSON between calls. */
  readonly temperature: number | null;
  /** True sends `response_format: {type: "json_object"}`; absent leaves the response format to the provider. */
  readonly json_mode: boolean;
  /** The owner's declared class for this destination; null is undeclared, which source consent treats as the loosest. */
  readonly retention: LlmRetentionClass | null;
}

const ALLOWED_KEYS = new Set([
  "base_url",
  "model",
  "secret_ref",
  "timeout_ms",
  "max_retries",
  "reasoning_effort",
  "provider",
  "temperature",
  "json_mode",
  "retention",
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

function parseReasoningEffort(value: unknown): ReasoningEffort | null {
  // Null is the parsed form of absence, so a parsed config parses again.
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !(REASONING_EFFORTS as readonly string[]).includes(value)) {
    configError(`reasoning_effort must be one of ${REASONING_EFFORTS.join(", ")}`);
  }
  return value as ReasoningEffort;
}

function parseProvider(value: unknown): ProviderPrivacy | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) configError("provider must be a table");
  const provider: { -readonly [K in keyof ProviderPrivacy]: ProviderPrivacy[K] } = {};
  for (const key of Object.keys(value)) {
    if (!PROVIDER_KEYS.has(key)) configError(`unknown provider key ${key}`);
  }
  const dataCollection = value["data_collection"];
  if (dataCollection !== undefined) {
    if (dataCollection !== "allow" && dataCollection !== "deny") configError("provider.data_collection must be allow or deny");
    provider.data_collection = dataCollection;
  }
  for (const key of ["zdr", "allow_fallbacks"] as const) {
    const flag = value[key];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") configError(`provider.${key} must be a boolean`);
    provider[key] = flag;
  }
  for (const key of PROVIDER_LISTS) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PROVIDER_LIST ||
      !list.every((name): name is string => typeof name === "string" && PROVIDER_NAME.test(name))) {
      configError(`provider.${key} must be a list of provider names`);
    }
    provider[key] = [...list];
  }
  return Object.keys(provider).length === 0 ? undefined : provider;
}

function parseTemperature(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) {
    configError("temperature must be a number from 0 to 2");
  }
  return value;
}

function parseJsonMode(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") configError("json_mode must be a boolean");
  return value;
}

/**
 * A declaration is only as strong as what the request asks for: zero retention must be requested on
 * the wire, without fallbacks to another provider, unless the endpoint is this machine.
 */
function parseRetention(value: unknown, url: URL, provider: ProviderPrivacy | undefined): LlmRetentionClass | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !(DECLARED_RETENTION_CLASSES as readonly string[]).includes(value)) {
    configError(`retention must be one of ${DECLARED_RETENTION_CLASSES.join(", ")}`);
  }
  const declared = value as LlmRetentionClass;
  if (isLoopbackHost(url.hostname)) return declared;
  if (declared === "zero_retention" && !(provider?.zdr === true && provider.allow_fallbacks === false)) {
    configError("retention zero_retention needs provider.zdr = true and provider.allow_fallbacks = false, or a loopback base_url");
  }
  if (declared === "logged_no_training" && provider?.data_collection !== "deny" && provider?.zdr !== true) {
    configError('retention logged_no_training needs provider.data_collection = "deny" or provider.zdr = true');
  }
  return declared;
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

  const provider = parseProvider(value["provider"]);
  return {
    base_url: url.href.replace(/\/+$/, ""),
    model: value["model"],
    secret_ref: typeof secret === "string" ? secret : null,
    timeout_ms: parseTimeout(value["timeout_ms"]),
    max_retries: parseRetries(value["max_retries"]),
    reasoning_effort: parseReasoningEffort(value["reasoning_effort"]),
    ...(provider === undefined ? {} : { provider }),
    temperature: parseTemperature(value["temperature"]),
    json_mode: parseJsonMode(value["json_mode"]),
    retention: parseRetention(value["retention"], url, provider),
  };
}
