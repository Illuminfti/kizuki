import { failure, failureRule, object, type XApiSelection } from "./state";

export const X_API_ORIGIN = "https://api.x.com";
export const X_API_OPERATION_MS = 45_000;
export const X_API_REQUEST_MS = 5_000;
export const X_API_REQUEST_LIMIT = 5;
export const X_API_RESPONSE_BYTES = 2 * 1024 * 1024;
export type XApiFetch = (request: Request) => Promise<Response>;
export class ApiBudget {
  private readonly end: number;
  private requests = 0;
  constructor(private readonly clock: () => number = Date.now, duration = X_API_OPERATION_MS) { this.end = clock() + duration; }
  remaining(): number {
    const left = this.end - this.clock();
    if (!Number.isFinite(left) || left <= 0) throw failure("timeout");
    return left;
  }
  requestMs(): number {
    const ms = Math.min(X_API_REQUEST_MS, this.remaining());
    if (this.requests >= X_API_REQUEST_LIMIT) throw failure("request_limit");
    this.requests++;
    return ms;
  }
}
export class HttpFailure extends Error {
  constructor(readonly status: number, readonly retrySeconds: number | null = null) { super("X API request refused"); }
}
function retrySeconds(response: Response): number {
  const after = response.headers.get("retry-after");
  if (after !== null && /^\d{1,10}$/.test(after)) return Math.max(1, Number(after));
  if (after !== null && after.length <= 64) {
    const when = Date.parse(after);
    if (Number.isFinite(when)) return Math.max(1, Math.ceil((when - Date.now()) / 1000));
  }
  const reset = response.headers.get("x-rate-limit-reset");
  return reset !== null && /^\d{1,10}$/.test(reset) ? Math.max(1, Number(reset) - Math.floor(Date.now() / 1000)) : 60;
}
async function readJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > X_API_RESPONSE_BYTES) || response.body === null) {
    void response.body?.cancel().catch(() => undefined); throw failure("response_limit");
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) throw failure("timeout");
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) throw failure("timeout");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > X_API_RESPONSE_BYTES) throw failure("response_limit");
      chunks.push(part.value);
    }
  } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch { throw failure(); }
}
/** GET only, fixed sanctioned origin and routes, with a single whole-response timeout. */
export async function request(url: URL, accessToken: string, budget: ApiBudget, fetcher: XApiFetch = request => fetch(request)): Promise<Record<string, unknown>> {
  if (url.origin !== X_API_ORIGIN || url.username || url.password || url.hash || url.href.length > 8192 ||
    !(url.pathname === "/2/users/me" || url.pathname === "/2/tweets" || /^\/2\/users\/[1-9][0-9]{0,18}\/tweets$/.test(url.pathname))) throw failure("misconfigured");
  const ms = budget.requestMs(), controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure("timeout")); }, ms); }),
      (async () => {
        const response = await fetcher(new Request(url, { method: "GET", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }));
        if (controller.signal.aborted || response.redirected || response.url !== "" && response.url !== url.href) {
          void response.body?.cancel().catch(() => undefined); throw failure(controller.signal.aborted ? "timeout" : "provider_error");
        }
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => undefined);
          throw new HttpFailure(response.status, response.status === 429 ? retrySeconds(response) : null);
        }
        return readJson(response, controller.signal);
      })(),
    ]);
  } catch (error) {
    if (error instanceof HttpFailure) throw error;
    throw failure(failureRule(error) ?? "unreachable");
  } finally { clearTimeout(timer); controller.abort(); }
}
export function fieldsQuery(selected: XApiSelection): URLSearchParams {
  const fields = ["id", "text", "author_id", "created_at", "edit_history_tweet_ids", "note_tweet"];
  if (selected.fields.includes("relationships")) fields.push("referenced_tweets", "in_reply_to_user_id");
  if (selected.fields.includes("relationships") || selected.fields.includes("links")) fields.push("entities");
  const query = new URLSearchParams({ "tweet.fields": fields.join(",") });
  if (selected.fields.includes("media")) {
    fields.push("attachments"); query.set("tweet.fields", fields.join(","));
    query.set("expansions", "attachments.media_keys"); query.set("media.fields", "media_key,type,url,preview_image_url");
  }
  return query;
}
