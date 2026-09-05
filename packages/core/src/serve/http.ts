import { withDeadline } from "../util/deadline";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { OWNER, TOOLS, authenticate } from "../agents";
import type { Principal, Tool } from "../agents";
import { initAgents } from "../agents/schema";
import { ServeError, dispatchServeTool } from "../serving";
import type { ServeContext } from "../serving";
import { SERVE_TOKEN_PATH, ServeDaemonError } from "./types";

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

export interface ServeHttpOptions {
  readonly mode?: never;
  readonly db: ServeContext["db"];
  readonly vaultPath: string;
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly retrieval?: ServeContext["retrieval"];
}

interface AppHttpOptions {
  readonly mode: "app";
  readonly assets: Readonly<Record<string, { body: string; type: string }>>;
  readonly handle: (request: Request) => Promise<Response>;
}
interface AppHttpHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** Trusted launcher only. Never log, write to disk or serve in asset bodies. */
  readonly token: string;
  stop(): Promise<void>;
}

export interface ServeHttpHandle {
  readonly host: string;
  readonly port: number;
  readonly tokenPath: string;
  readonly url: string;
  stop(): Promise<void>;
}

function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

function writeToken(vaultPath: string, token: string): string {
  const path = join(vaultPath, SERVE_TOKEN_PATH);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function principalFor(
  db: ServeContext["db"],
  minted: string,
  presented: string | null,
): Principal | null {
  if (presented === null) return null;
  if (presented === minted) return OWNER;
  return authenticate(db, presented);
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refused(error: unknown): Response {
  if (error instanceof ServeError) {
    const status = error.code === "rate_limited" ? 429 : 400;
    return json(status, {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: false,
        retry_after_seconds: error.retry_after_seconds,
      },
    });
  }
  return json(400, {
    ok: false,
    error: { code: "error", message: "serving failed", retryable: false },
  });
}

/**
 * Standing loopback MCP endpoint under `kizuki serve` (RFC 0002 §3.6 / §11).
 * Binds 127.0.0.1 or ::1 only. The token is minted at start and rotated on
 * restart; it is written to a 0600 file and never logged.
 */
export function startServeHttp(options: AppHttpOptions): AppHttpHandle;
export function startServeHttp(options: ServeHttpOptions): ServeHttpHandle;
export function startServeHttp(options: ServeHttpOptions | AppHttpOptions): ServeHttpHandle | AppHttpHandle {
  const host = options.mode === "app" ? "127.0.0.1" : options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) {
    throw new ServeDaemonError(
      "bind_refused",
      "serve http refuses a non-loopback host",
    );
  }
  if (options.mode !== "app") initAgents(options.db);
  const token = options.mode === "app" ? mintToken() : options.token ?? mintToken();
  const tokenPath = options.mode === "app" ? null : writeToken(options.vaultPath, token);
  let boundOrigin = "";

  const server = Bun.serve({
    hostname: host,
    port: options.mode === "app" ? 0 : options.port ?? 0,
    async fetch(request) {
      if (options.mode === "app") return appRequest(request, boundOrigin, token, options);
      const url = new URL(request.url);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
        return json(403, { ok: false, error: { code: "bind_refused", message: "loopback only", retryable: false } });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json(200, { ok: true, bind: host });
      }
      const presented = bearer(request);
      const principal = principalFor(options.db, token, presented);
      if (principal === null) {
        return json(401, {
          ok: false,
          error: { code: "unauthorized", message: "missing or unknown bearer token", retryable: false },
        });
      }
      const match = /^\/v1\/(?:mcp\/)?([a-z_]+)$/.exec(url.pathname);
      const tool = match?.[1];
      if (request.method !== "POST" || tool === undefined || !(TOOLS as readonly string[]).includes(tool)) {
        return json(404, {
          ok: false,
          error: { code: "not_found", message: "unknown tool", retryable: false },
        });
      }
      let args: Record<string, unknown> = {};
      try {
        const body = await request.json();
        if (body !== null && typeof body === "object" && !Array.isArray(body)) {
          const record = body as Record<string, unknown>;
          args = (record["args"] as Record<string, unknown> | undefined) ?? record;
        }
      } catch {
        return json(400, {
          ok: false,
          error: { code: "config_invalid", message: "body must be JSON", retryable: false },
        });
      }
      try {
        const envelope = await dispatchServeTool(
          { db: options.db, vaultPath: options.vaultPath, principal,
            ...(options.retrieval === undefined ? {} : { retrieval: options.retrieval }),
          },
          tool as Tool,
          args,
        );
        return json(200, { ok: true, value: envelope });
      } catch (error) {
        return refused(error);
      }
    },
  });

  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new ServeDaemonError("bind_refused", "serve http did not bind a port");
  }
  boundOrigin = `http://${host}:${port}`;
  const common = { host, port, url: boundOrigin, async stop() { server.stop(true); } };
  return options.mode === "app" ? { ...common, token } : { ...common, tokenPath: tokenPath! };
}

const APP_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
};
async function appRequest(request: Request, origin: string, token: string, options: AppHttpOptions): Promise<Response> {
  const reply = (response: Response) => {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(APP_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  };
  const error = (status: number, code: string) => reply(json(status, { ok: false, error: { code, retryable: false } }));
  const url = new URL(request.url), expected = new URL(origin);
  if (url.origin !== origin || request.headers.get("host") !== expected.host || url.search !== "") return error(403, "origin_refused");
  const presentedOrigin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
  if (presentedOrigin !== null && presentedOrigin !== origin || site !== null && site !== "same-origin" && site !== "none") return error(403, "origin_refused");
  if (request.method === "GET" && ["/", "/app/assets/client.js", "/app/assets/app.css"].includes(url.pathname) && Object.hasOwn(options.assets, url.pathname)) {
    const asset = options.assets[url.pathname]!;
    return reply(new Response(asset.body, { headers: { "content-type": asset.type } }));
  }
  if (request.method !== "POST" || !/^\/app\/v1\/[a-z_]+$/.test(url.pathname)) return error(404, "not_found");
  if (presentedOrigin !== origin) return error(403, "origin_refused");
  const presented = bearer(request);
  if (presented === null || Buffer.byteLength(presented) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(presented), Buffer.from(token))) return error(401, "unauthorized");
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error(400, "invalid_request");
  try {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    const deadline = Date.now() + 5000;
    if (reader) while (true) {
      if (Date.now() >= deadline) { await reader.cancel(); return error(408, "invalid_request"); }
      const next = await withDeadline(reader.read(), Math.max(1, deadline - Date.now()), "app body deadline"); if (next.done) break;
      size += next.value.byteLength;
      if (size > 128 * 1024) { await reader.cancel(); return error(413, "invalid_request"); }
      chunks.push(next.value);
    }
    const bytes = Buffer.concat(chunks);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return reply(await options.handle(new Request(url, { method: "POST", headers: request.headers, body })));
  } catch { return error(400, "invalid_request"); }
}
