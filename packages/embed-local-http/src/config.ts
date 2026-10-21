import { isPlainObject, PortError } from "@kizuki/core";
import { estimateTokens } from "./tokens";

export const EMBEDDING_APIS = ["openai", "ollama"] as const;
export type EmbeddingApi = (typeof EMBEDDING_APIS)[number];

const API_PATHS: Readonly<Record<EmbeddingApi, string>> = {
  openai: "/v1/embeddings",
  ollama: "/api/embed",
};

export const DEFAULT_PROMPT_QUERY = "{q}";
export const DEFAULT_PROMPT_DOC = "{title}\n\n{text}";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_BATCH_SIZE = 16;
export const MAX_DIMS = 2_000;
/** Tokens the framed document title may occupy; longer titles are cut. */
export const TITLE_TOKEN_CAP = 64;
/** Room for the special tokens a model adds around one input. */
export const SPECIAL_TOKEN_ALLOWANCE = 8;

export interface LocalHttpEmbeddingConfig {
  readonly api: EmbeddingApi;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly model: string;
  readonly dims: number;
  readonly max_input_tokens: number;
  readonly chunk_tokens: number;
  readonly chunk_overlap: number;
  readonly batch_size: number;
  readonly timeout_ms: number;
  readonly prompt_query: string;
  readonly prompt_doc: string;
  readonly expected_space: string | null;
}

function invalid(message: string): never {
  throw new PortError("config_invalid", message, false);
}

function pinnedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (value === "auto" || value === undefined || value === null) {
    invalid(`${field} must be pinned explicitly; auto-sizing is forbidden`);
  }
  return boundedInteger(value, field, min, max);
}

function boundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    invalid(`${field} must be an integer`);
  }
  if (value < min || value > max)
    invalid(`${field} must be between ${min} and ${max}`);
  return value;
}

function template(
  value: unknown,
  field: string,
  fallback: string,
  required: string,
): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > 512) {
    invalid(`${field} must be a string of at most 512 characters`);
  }
  if (!value.includes(required)) invalid(`${field} must contain ${required}`);
  return value;
}

/** The literal words a template adds around its slots. */
function templateOverhead(value: string): number {
  return estimateTokens(value.replaceAll(/\{(?:q|title|text)\}/g, " "));
}

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Only an address literal on the loopback interface is accepted. The URL
 * parser has already folded decimal, octal and hexadecimal spellings of an
 * IPv4 address into dotted form, so `2130706433` and `0x7f.1` arrive here as
 * `127.0.0.1`. A hostname is refused because resolving it is a lookup the
 * owner's resolver decides, not this package.
 */
export function parseLoopbackEndpoint(value: unknown): {
  host: string;
  port: number;
} {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    invalid("endpoint is required");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("endpoint must be an http URL");
  }
  if (url.protocol !== "http:")
    invalid("endpoint must use plain http on the loopback interface");
  if (url.username !== "" || url.password !== "")
    invalid("endpoint must not carry credentials");
  if (url.search !== "" || url.hash !== "")
    invalid("endpoint must not carry a query or fragment");
  if (url.pathname !== "/")
    invalid("endpoint must be an origin; the request path follows from api");
  const host = url.hostname;
  if (host !== "[::1]" && !IPV4_LOOPBACK.test(host)) {
    invalid(
      "endpoint must be a loopback address literal (127.0.0.0/8 or [::1]), not a hostname",
    );
  }
  const port = url.port === "" ? 80 : Number(url.port);
  return { host: host === "[::1]" ? "::1" : host, port };
}

export function parseLocalHttpEmbeddingConfig(
  value: Readonly<Record<string, unknown>>,
): LocalHttpEmbeddingConfig {
  if (!isPlainObject(value)) invalid("embedding config must be a table");
  const api = value["api"];
  if (!(EMBEDDING_APIS as readonly unknown[]).includes(api)) {
    invalid(`api must be one of ${EMBEDDING_APIS.join(", ")}`);
  }
  const { host, port } = parseLoopbackEndpoint(value["endpoint"]);
  const model = value["model"];
  if (
    typeof model !== "string" ||
    model.length === 0 ||
    model.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(model)
  ) {
    invalid("model is required and must be a plain model id");
  }
  const dims = pinnedInteger(value["dims"], "dims", 1, MAX_DIMS);
  const maxInput = pinnedInteger(
    value["max_input_tokens"],
    "max_input_tokens",
    32,
    131_072,
  );
  const promptQuery = template(
    value["prompt_query"],
    "prompt_query",
    DEFAULT_PROMPT_QUERY,
    "{q}",
  );
  const promptDoc = template(
    value["prompt_doc"],
    "prompt_doc",
    DEFAULT_PROMPT_DOC,
    "{text}",
  );

  const overhead =
    templateOverhead(promptDoc) + TITLE_TOKEN_CAP + SPECIAL_TOKEN_ALLOWANCE;
  const room = maxInput - overhead;
  if (room < 16)
    invalid(
      "max_input_tokens leaves no room for a chunk after the prompt, title and special tokens",
    );
  const chunkTokens =
    value["chunk_tokens"] === undefined
      ? Math.min(400, room)
      : boundedInteger(value["chunk_tokens"], "chunk_tokens", 16, room);
  const chunkOverlap =
    value["chunk_overlap"] === undefined
      ? Math.floor(chunkTokens * 0.15)
      : boundedInteger(
          value["chunk_overlap"],
          "chunk_overlap",
          0,
          chunkTokens - 1,
        );

  const expected = value["expected_space"];
  if (
    expected !== undefined &&
    expected !== null &&
    (typeof expected !== "string" || expected.length === 0)
  ) {
    invalid("expected_space must be a non-empty string when set");
  }

  return Object.freeze({
    api: api as EmbeddingApi,
    host,
    port,
    path: API_PATHS[api as EmbeddingApi],
    model,
    dims,
    max_input_tokens: maxInput,
    chunk_tokens: chunkTokens,
    chunk_overlap: chunkOverlap,
    batch_size:
      value["batch_size"] === undefined
        ? DEFAULT_BATCH_SIZE
        : boundedInteger(value["batch_size"], "batch_size", 1, 64),
    timeout_ms:
      value["timeout_ms"] === undefined
        ? DEFAULT_TIMEOUT_MS
        : boundedInteger(value["timeout_ms"], "timeout_ms", 100, 300_000),
    prompt_query: promptQuery,
    prompt_doc: promptDoc,
    expected_space: typeof expected === "string" ? expected : null,
  });
}
