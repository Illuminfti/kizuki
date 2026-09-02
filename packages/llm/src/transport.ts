export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: readonly ChatMessage[];
  temperature: number;
  max_tokens: number;
  response_format?: { type: "json_object" };
}

export interface TransportOptions {
  url: string;
  api_key: string | null;
  timeout_ms: number;
  max_response_bytes: number;
}

export type TransportFailure =
  | "timeout"
  | "network"
  | "redirect"
  | "too_large"
  | "not_json";

export type TransportResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; retry_after_ms: number | null }
  | { ok: false; status: 0; failure: TransportFailure };

export type ChatTransport = (
  request: ChatRequest,
  opts: TransportOptions,
) => Promise<TransportResult>;

/** Bun reports the refusal to follow a redirect as `code`, not as `name`. */
function failureOf(error: unknown): TransportFailure {
  if (!(error instanceof Error)) return "network";
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return "timeout";
  }
  const code = (error as { code?: unknown }).code;
  return code === "UnexpectedRedirect" ? "redirect" : "network";
}

/** Seconds or an HTTP date, per RFC 9110; anything else is no guidance. */
function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

/**
 * Reads the reply chunk by chunk and gives up the moment the running total
 * passes the cap, so an endpoint that streams without a `content-length`
 * cannot make this process allocate more than the owner allowed.
 */
export async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The single network call of the product, allowlisted in
 * scripts/network-allowlist.txt. It speaks only to the URL the owner
 * configured, sends no identifying header, follows no redirect, and reads a
 * bounded, JSON-only reply that the caller still has to validate.
 */
export const fetchTransport: ChatTransport = async (request, opts) => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (opts.api_key !== null) {
    headers["authorization"] = `Bearer ${opts.api_key}`;
  }

  let response: Response;
  try {
    response = await fetch(opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeout_ms),
    });
  } catch (error) {
    return { ok: false, status: 0, failure: failureOf(error) };
  }

  if (!response.ok) {
    // The body of a failure is provider prose: never read, never logged.
    await response.body?.cancel();
    return {
      ok: false,
      status: response.status,
      retry_after_ms: retryAfterMs(response.headers.get("retry-after")),
    };
  }

  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > opts.max_response_bytes) {
    await response.body?.cancel();
    return { ok: false, status: 0, failure: "too_large" };
  }

  let text: string | null;
  try {
    text = await readBoundedBody(response, opts.max_response_bytes);
  } catch (error) {
    return { ok: false, status: 0, failure: failureOf(error) };
  }
  if (text === null) return { ok: false, status: 0, failure: "too_large" };

  try {
    return { ok: true, status: response.status, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 0, failure: "not_json" };
  }
};
