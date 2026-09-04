import { isPlainObject } from "@kizuki/core";

export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export interface TransportRequest {
  readonly url: string;
  readonly api_key: string | null;
  readonly timeout_ms: number;
  readonly max_response_bytes: number;
  readonly body: unknown;
}

export type TransportFailure =
  | "timeout"
  | "network"
  | "redirect"
  | "too_large"
  | "not_json";

export type TransportResult =
  | {
      readonly ok: true;
      readonly kind: "ok";
      readonly status: number;
      readonly body: unknown;
    }
  | {
      readonly ok: false;
      readonly kind: "http";
      readonly status: number;
      readonly retry_after_ms: number | null;
    }
  | {
      readonly ok: false;
      readonly kind: "transport";
      readonly status: 0;
      readonly failure: TransportFailure;
    };

export type ChatTransport = (
  request: TransportRequest,
) => Promise<TransportResult>;

function classifyFetchError(error: unknown): TransportFailure {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "timeout";
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "timeout";
    }
    if (
      error.name === "UnexpectedRedirect" ||
      error.message.startsWith("UnexpectedRedirect")
    ) {
      return "redirect";
    }
  }
  return "network";
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.length === 0) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
    return seconds * 1000;
  }
  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

function contentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null || raw.length === 0) return null;
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 0) return null;
  return size;
}

async function readBoundedBody(response: Response, limit: number): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        try {
          await reader.cancel();
        } catch {
          // A peer may have already closed the connection. The byte bound still applies.
        }
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort; the response is still rejected locally.
  }
}

/**
 * The single fetch of `@kizuki/llm`. Callers must pass a user-configured
 * URL; this function does not choose a host.
 */
export const fetchTransport: ChatTransport = async (request) => {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  if (request.api_key !== null) {
    headers.set("authorization", `Bearer ${request.api_key}`);
  }

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      redirect: "error",
      signal: AbortSignal.timeout(request.timeout_ms),
    });
  } catch (error) {
    return {
      ok: false,
      kind: "transport",
      status: 0,
      failure: classifyFetchError(error),
    };
  }

  const announced = contentLength(response.headers);
  if (
    announced !== null &&
    announced > request.max_response_bytes
  ) {
    await cancelBody(response);
    return { ok: false, kind: "transport", status: 0, failure: "too_large" };
  }

  let text: string | null;
  try {
    text = await readBoundedBody(response, request.max_response_bytes);
  } catch (error) {
    return {
      ok: false,
      kind: "transport",
      status: 0,
      failure: classifyFetchError(error),
    };
  }
  if (text === null) {
    return { ok: false, kind: "transport", status: 0, failure: "too_large" };
  }

  if (!response.ok) {
    return {
      ok: false,
      kind: "http",
      status: response.status,
      retry_after_ms: parseRetryAfter(response.headers.get("retry-after")),
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, kind: "transport", status: 0, failure: "not_json" };
  }
  if (!isPlainObject(body) && !Array.isArray(body)) {
    return { ok: false, kind: "transport", status: 0, failure: "not_json" };
  }

  return { ok: true, kind: "ok", status: response.status, body };
};
