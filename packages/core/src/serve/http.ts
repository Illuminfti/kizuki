import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { OWNER, TOOLS, authenticate } from "../agents";
import type { Principal, Tool } from "../agents";
import { initAgents } from "../agents/schema";
import {
  serveContextPacket,
  serveCorrect,
  serveEntities,
  serveGetPage,
  serveGraph,
  serveHealth,
  servePropose,
  serveSearch,
  serveTimeline,
} from "../serving";
import type { ServeContext } from "../serving";
import { SERVE_TOKEN_PATH, ServeDaemonError } from "./types";

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

export interface ServeHttpOptions {
  readonly db: ServeContext["db"];
  readonly vaultPath: string;
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
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

async function dispatch(ctx: ServeContext, tool: Tool, args: Record<string, unknown>) {
  switch (tool) {
    case "search":
      return serveSearch(ctx, args as never);
    case "get_page":
      return serveGetPage(ctx, args as never);
    case "query_entities":
      return serveEntities(ctx, args as never);
    case "timeline":
      return serveTimeline(ctx, args as never);
    case "context_packet":
      return serveContextPacket(ctx, args as never);
    case "graph_neighbors":
      return serveGraph(ctx, args as never);
    case "system_health":
      return serveHealth(ctx);
    case "propose":
      return servePropose(ctx, args as never);
    case "correct":
      return serveCorrect(ctx, args as never);
  }
}

/**
 * Standing loopback MCP endpoint under `kizuki serve` (RFC 0002 §3.6 / §11).
 * Binds 127.0.0.1 or ::1 only. The token is minted at start and rotated on
 * restart; it is written to a 0600 file and never logged.
 */
export function startServeHttp(options: ServeHttpOptions): ServeHttpHandle {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) {
    throw new ServeDaemonError(
      "bind_refused",
      "serve http refuses a non-loopback host",
    );
  }
  initAgents(options.db);
  const token = options.token ?? mintToken();
  const tokenPath = writeToken(options.vaultPath, token);

  const server = Bun.serve({
    hostname: host,
    port: options.port ?? 0,
    async fetch(request) {
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
        const envelope = await dispatch(
          { db: options.db, vaultPath: options.vaultPath, principal },
          tool as Tool,
          args,
        );
        return json(200, { ok: true, value: envelope });
      } catch {
        return json(400, {
          ok: false,
          error: { code: "not_supported", message: "tool refused", retryable: false },
        });
      }
    },
  });

  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new ServeDaemonError("bind_refused", "serve http did not bind a port");
  }
  return {
    host,
    port,
    tokenPath,
    url: `http://${host}:${port}`,
    async stop() {
      server.stop(true);
    },
  };
}
