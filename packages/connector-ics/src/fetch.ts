import { KizukiError } from "@kizuki/core";

export const MAX_CALENDAR_BYTES = 16 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 30_000;
export const ACCEPT = "text/calendar, text/plain;q=0.5";

export interface IcsFetchResult {
  status: number;
  etag: string | null;
  last_modified: string | null;
  text: string;
}

export interface ConditionalHeaders {
  etag?: string;
  last_modified?: string;
}

export type IcsFetcher = (
  url: string,
  conditional: ConditionalHeaders,
) => Promise<IcsFetchResult>;

/**
 * Just the call signature this module needs. The platform's `fetch` carries
 * extra members a test stub has no business implementing.
 */
export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

function statusFailure(status: number): KizukiError {
  if (status === 401 || status === 403) {
    return new KizukiError(
      "unauthenticated",
      `kizuki.ics: calendar refused the request (${status})`,
    );
  }
  if (status === 404 || status === 410) {
    return new KizukiError(
      "misconfigured",
      `kizuki.ics: calendar is not there (${status})`,
    );
  }
  if (status === 429) {
    return new KizukiError(
      "rate_limited",
      "kizuki.ics: calendar is rate limiting",
    );
  }
  return new KizukiError(
    "unreachable",
    `kizuki.ics: calendar returned status ${status}`,
  );
}

/** The kind of failure, without whatever text the platform attached to it. */
function errorLabel(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z]{1,40}$/.test(name) ? name : "unknown";
}

function requireHttps(candidate: string): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new KizukiError(
      "misconfigured",
      "kizuki.ics: calendar URL is malformed",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new KizukiError(
      "misconfigured",
      "kizuki.ics: only https:// calendar URLs are supported",
    );
  }
  return parsed.toString();
}

async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_CALENDAR_BYTES) {
        await reader.cancel();
        throw new KizukiError(
          "misconfigured",
          "kizuki.ics: calendar exceeds 16 MiB",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const piece of chunks) {
    merged.set(piece, offset);
    offset += piece.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * The only network call in this package, and the only one an owner opts into
 * by typing a calendar URL. Redirects are followed by hand so every hop is
 * re-checked for https; error messages carry the status, never the URL,
 * because a private calendar URL is itself the credential.
 */
export function makeFetcher(fetchImpl: FetchLike): IcsFetcher {
  return async (url, conditional) => {
    let target = requireHttps(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const headers: Record<string, string> = { Accept: ACCEPT };
      if (conditional.etag !== undefined) {
        headers["If-None-Match"] = conditional.etag;
      }
      if (conditional.last_modified !== undefined) {
        headers["If-Modified-Since"] = conditional.last_modified;
      }

      let outcome: IcsFetchResult | { redirect: string };
      try {
        const response = await fetchImpl(target, {
          method: "GET",
          headers,
          redirect: "manual",
          credentials: "omit",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const etag = response.headers.get("etag");
        const lastModified = response.headers.get("last-modified");
        if (response.status === 304) {
          outcome = { status: 304, etag, last_modified: lastModified, text: "" };
        } else if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location === null) throw statusFailure(response.status);
          outcome = { redirect: new URL(location, target).toString() };
        } else if (!response.ok) {
          throw statusFailure(response.status);
        } else {
          outcome = {
            status: response.status,
            etag,
            last_modified: lastModified,
            // Reading the body belongs inside this guard: a stream that fails
            // mid-flight reports the request URL in its own message.
            text: await readBounded(response),
          };
        }
      } catch (error) {
        if (error instanceof KizukiError) throw error;
        // The cause is dropped rather than chained: a private calendar URL is
        // the credential, and the platform puts it in the failure it raises.
        throw new KizukiError(
          "unreachable",
          `kizuki.ics: calendar is unreachable (${errorLabel(error)})`,
        );
      }

      if ("redirect" in outcome) {
        target = requireHttps(outcome.redirect);
        continue;
      }
      return outcome;
    }
    throw new KizukiError("misconfigured", "kizuki.ics: too many redirects");
  };
}

/**
 * The one place the global fetch is invoked. It is called rather than passed
 * by reference so the source gate sees a real network call here and the
 * allowlist entry naming this file stays honest.
 */
const globalFetch: FetchLike = (input, init) => fetch(input, init);

export const fetchIcs: IcsFetcher = makeFetcher(globalFetch);
