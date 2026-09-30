import { DeadlineError, withDeadline } from "../util/deadline";

export const MAX_HTTP_BODY_BYTES = 128 * 1024;
export const HTTP_BODY_TIMEOUT_MS = 5000;
const MAX_JSON_DEPTH = 64;

export class HttpBodyError extends Error {
  constructor(readonly status: 400 | 408 | 413) {
    super("body must be bounded UTF-8 JSON");
  }
}

/** Bound reads before decoding, including chunked bodies with no length header. */
export async function readRequestText(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  // Fixed storage also bounds empty/tiny chunk floods independently of byte count.
  const bytes = new Uint8Array(MAX_HTTP_BODY_BYTES);
  let size = 0;
  const deadline = Date.now() + HTTP_BODY_TIMEOUT_MS;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new HttpBodyError(408);
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await withDeadline(reader.read(), remaining, "HTTP body deadline");
      } catch (error) {
        throw new HttpBodyError(error instanceof DeadlineError ? 408 : 400);
      }
      if (next.done) break;
      if (size + next.value.byteLength > MAX_HTTP_BODY_BYTES) throw new HttpBodyError(413);
      bytes.set(next.value, size);
      size += next.value.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    } catch {
      throw new HttpBodyError(400);
    }
  } catch (error) {
    // Cancellation must not wait for an attacker-controlled stream to settle.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Avoid allocating a deeply nested graph before the tool validates its fields. */
export function parseRequestArguments(text: string): Record<string, unknown> {
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > MAX_JSON_DEPTH) throw new HttpBodyError(400);
    } else if (char === "}" || char === "]") depth -= 1;
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new HttpBodyError(400); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpBodyError(400);
  const record = raw as Record<string, unknown>;
  if (!Object.hasOwn(record, "args")) return record;
  const args = record["args"];
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new HttpBodyError(400);
  return args as Record<string, unknown>;
}
