import {
  OAuthError,
  assertRedirectPath,
  type LoopbackListener,
  type OAuthTransport,
} from "./oauth";

const CALLBACK_PAGE =
  "<!doctype html><title>Kizuki</title><p>Sign-in received. You can close this tab and return to the terminal.</p>";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_POST_TIMEOUT_MS = 30_000;
const LISTENER = "loopback";

interface Waiter {
  resolve: (url: URL) => void;
  reject: (error: Error) => void;
}

async function readCapped(response: Response): Promise<string> {
  const stream = response.body;
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OAuthError(
          "transport",
          LISTENER,
          "response exceeded the size cap",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/**
 * The one transport in core that opens a socket, declared with its reason in
 * `scripts/network-allowlist.txt`. It is deliberately dumb: it moves bytes for
 * `auth/oauth.ts` and holds no policy, no secrets and no logging.
 * A fixed redirectUri binds its registered port; omission uses an ephemeral port.
 */
export function loopbackTransport(
  opts: { redirectUri?: string; postTimeoutMs?: number } = {},
): OAuthTransport {
  const postTimeoutMs = opts.postTimeoutMs ?? DEFAULT_POST_TIMEOUT_MS;
  const redirectUri = opts.redirectUri;
  let port = 0;
  if (redirectUri !== undefined) {
    // Keep the registered URI exact: URL parsing would normalize host aliases,
    // dot segments and default ports instead of refusing those spellings.
    const match =
      typeof redirectUri === "string"
        ? /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/callback$/.exec(redirectUri)
        : null;
    if (match === null || match[0] !== redirectUri || Number(match[1]) > 65535) {
      throw new TypeError(
        "redirectUri must be http://127.0.0.1:<port>/callback with port 1-65535",
      );
    }
    port = Number(match[1]);
  }
  return {
    async listen(redirectPath: string): Promise<LoopbackListener> {
      // The transport is the one that builds the redirect URI, so it judges
      // the path itself rather than trusting whoever assembled the call.
      assertRedirectPath(redirectPath);
      if (redirectUri !== undefined && redirectPath !== "/callback") {
        throw new TypeError("redirect_path must match the fixed redirectUri path");
      }
      const waiters: Waiter[] = [];
      let received: URL | null = null;
      let closed = false;

      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch(request: Request): Response {
          const url = new URL(request.url);
          if (request.method !== "GET" || url.pathname !== redirectPath) {
            return new Response(null, { status: 404 });
          }
          if (received === null) {
            received = url;
            for (const waiter of waiters.splice(0)) waiter.resolve(url);
          }
          // The page never reflects the query: the code lands in the terminal,
          // not in a rendered document a browser extension could read.
          return new Response(CALLBACK_PAGE, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      });

      return {
        redirect_uri: `http://127.0.0.1:${server.port}${redirectPath}`,
        callback(): Promise<URL> {
          if (closed) {
            return Promise.reject(new OAuthError("timeout", LISTENER));
          }
          if (received !== null) return Promise.resolve(received);
          return new Promise<URL>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          for (const waiter of waiters.splice(0)) {
            waiter.reject(new OAuthError("timeout", LISTENER));
          }
          await server.stop(true);
        },
      };
    },

    async postForm(
      url: string,
      form: Record<string, string>,
    ): Promise<{ status: number; body: unknown }> {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(postTimeoutMs),
        redirect: "error",
      });
      const text = await readCapped(response);
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: response.status, body };
    },
  };
}
