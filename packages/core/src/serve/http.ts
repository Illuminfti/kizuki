import { HttpBodyError, MAX_APP_HTTP_BODY_BYTES, parseRequestObject, readRequestText } from "./request-body";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { countAgents, OWNER, TOOLS, authenticate } from "../agents";
import type { Principal, Tool } from "../agents";
import { initAgents } from "../agents/schema";
import { canonReadGeneration } from "../canon/write-intent";
import { countClaims, countPendingRetrievalOps } from "../claims/store";
import { purgeReadEpoch } from "../derived-holds";
import { readDerivedMeta } from "../derived-meta";
import { isLedgerBusy } from "../ledger/busy";
import { getCheckpoint, listConnections } from "../ledger/connections";
import { count } from "../ledger/ledger";
import { LEDGER_CONTROL_BUSY_TIMEOUT_MS } from "../ledger/limits";
import { readSqliteRuntime } from "../ledger/runtime";
import { sourcePolicyEpoch } from "../ledger/source-grants";
import { ServeError, scopedWriterRefusal, dispatchServeTool } from "../serving";
import type { ServeContext } from "../serving";
import { asSensitivity, asTaint, eligible, loadCanon } from "../serving/canon";
import { CanonAccessPhase } from "../serving/canon-access";
import { chooseContract, RESPONSE_CONTRACT_KEY, unsupportedContract } from "../serving/contract";
import { auditArguments, gate, ledgerBusyServeError, principalName, refuseCall } from "../serving/gate";
import type { Served } from "../serving/gate";
import type { HealthData } from "../serving/health";
import { ENVELOPE_SCHEMA, ENVELOPE_V2_SCHEMA } from "../serving/types";
import { isPlainObject } from "../util/validate";
import { SERVE_TOKEN_PATH, ServeDaemonError } from "./types";

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const HEALTH_SNAPSHOT_TTL_MS = 5_000;
const MAX_CACHED_PRINCIPALS = 16;

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

interface CachedHealthEntry {
  readonly stamp: string;
  readonly atMs: number;
  readonly data: HealthData;
}

function mintToken(): string {
  return `kzs_${randomBytes(32).toString("base64url")}`;
}

function writeToken(vaultPath: string, token: string): string {
  const path = join(vaultPath, SERVE_TOKEN_PATH);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Digest both sides so the compare takes the same time for any length or shared prefix. */
export function sameToken(presented: string, minted: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(minted));
}

function principalFor(
  db: ServeContext["db"],
  minted: string,
  presented: string | null,
): Principal | null {
  if (presented === null) return null;
  if (sameToken(presented, minted)) return OWNER;
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
  const writer = scopedWriterRefusal(error);
  if (writer !== null) return json(503, writer);
  if (error instanceof ServeError) {
    // The contract refusal is the same bytes for every cause, with no retry hint.
    if (error.code === "unsupported_contract") {
      return json(400, {
        ok: false,
        error: { code: error.code, message: error.message, retryable: false },
      });
    }
    const status = error.code === "rate_limited" ? 429 : error.code === "busy" ? 503 : 400;
    return json(status, {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.code === "busy",
        retry_after_seconds: error.retry_after_seconds,
      },
    });
  }
  return json(400, {
    ok: false,
    error: { code: "error", message: "serving failed", retryable: false },
  });
}

function withBoundedBusyWait<T>(db: ServeContext["db"], work: () => T): T {
  if (db.inTransaction) return work();
  const prior = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout ?? 5_000;
  const bounded = Math.min(prior, LEDGER_CONTROL_BUSY_TIMEOUT_MS);
  if (bounded !== prior) db.exec(`PRAGMA busy_timeout = ${bounded}`);
  try {
    return work();
  } catch (error) {
    if (error instanceof ServeError || !isLedgerBusy(error)) throw error;
    throw ledgerBusyServeError(error);
  } finally {
    if (!db.inTransaction && bounded !== prior) {
      try { db.exec(`PRAGMA busy_timeout = ${prior}`); } catch { /* Connection closing. */ }
    }
  }
}

function totalChanges(db: ServeContext["db"]): number {
  return db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? 0;
}

function healthStateStamp(db: ServeContext["db"], vaultPath: string, trackedAuditChanges: number): string {
  const row = db
    .query<{ changes: number; data_version: number; schema_version: number }, []>(
      "SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS data_version, (SELECT schema_version FROM pragma_schema_version) AS schema_version",
    )
    .get()!;
  const nonAuditChanges = row.changes - trackedAuditChanges;
  const canonGen = canonReadGeneration(db);
  const policyEpoch = sourcePolicyEpoch(db);
  const purgeEpoch = purgeReadEpoch(db);
  const rootMtime = statSync(vaultPath, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const autoMtime = statSync(join(vaultPath, "auto"), { throwIfNoEntry: false })?.mtimeMs ?? 0;
  return `${row.data_version}:${row.schema_version}:${nonAuditChanges}:${canonGen}:${policyEpoch}:${purgeEpoch}:${rootMtime}:${autoMtime}`;
}

/**
 * Computes owner `HealthData` with a shared `CanonAccessPhase` so large vaults
 * (10k+ pages) avoid redundant per-page SQLite receipt/source lookups on cold misses.
 */
function buildOwnerHealthServed(ctx: ServeContext): Served<HealthData> {
  const grant = ctx.principal.grant;
  const index = loadCanon(ctx, { include_archived: true });
  const access = new CanonAccessPhase(index, grant);

  let active = 0;
  let labeled = 0;
  let stamped = 0;
  let servable = 0;
  for (const page of index.pages) {
    if (asSensitivity(page.data["sensitivity"]) !== null) labeled += 1;
    if (asTaint(page.data["taint"]) !== null) stamped += 1;
    if (!eligible(page)) continue;
    active += 1;
    if (access.decision(page).allow) servable += 1;
  }

  const connections = listConnections(ctx.db).map((connection) => {
    const checkpoint = getCheckpoint(ctx.db, connection.connector_id, connection.source_key);
    return {
      connector_id: connection.connector_id,
      source_key: connection.source_key,
      connected_at: connection.connected_at,
      last_run_at: checkpoint?.last_run_at ?? null,
      last_result:
        checkpoint === null
          ? null
          : {
              stored: checkpoint.last_result.stored,
              duplicates: checkpoint.last_result.duplicates,
              errors: checkpoint.last_result.errors.length,
              proposals_created: checkpoint.last_result.proposals_created,
              withdrawn: checkpoint.last_result.withdrawn,
              retractions_filed: checkpoint.last_result.retractions_filed,
            },
    };
  });

  return {
    canon: [],
    quoted: [],
    withheld: [],
    data: {
      runtime: readSqliteRuntime(ctx.db),
      principal: {
        kind: ctx.principal.kind,
        name: principalName(ctx.principal),
        ceiling: grant.ceiling,
        tools: [...grant.tools],
      },
      pages: {
        total: index.pages.length,
        active,
        labeled,
        stamped,
        servable,
        held: index.pages.filter((page) => index.holds.has(page.relPath)).length,
        withheld: index.withheld.length,
      },
      withheld_pages: index.withheld.map((entry) => ({ path: entry.relPath, problem: entry.reason })),
      events: count(ctx.db),
      live_claims: countClaims(ctx.db, { status: "live" }),
      pending_retrieval_ops: countPendingRetrievalOps(ctx.db),
      derived: {
        search: readDerivedMeta(ctx.db, "search")?.rebuilt_at ?? null,
        graph: readDerivedMeta(ctx.db, "graph")?.rebuilt_at ?? null,
      },
      connections,
      agents: countAgents(ctx.db),
    },
  };
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

  const healthCache = new Map<string, CachedHealthEntry>();
  let trackedAuditChanges = 0;

  const serveFastHealth = async (
    principal: Principal,
    args: Record<string, unknown>,
    responseContract: unknown,
  ) => {
    const ctx: ServeContext = {
      db: options.mode === "app" ? (undefined as never) : options.db,
      vaultPath: options.mode === "app" ? "" : options.vaultPath,
      principal,
      servingSecrets: [token],
      ...(options.mode !== "app" && options.retrieval !== undefined ? { retrieval: options.retrieval } : {}),
    };
    const contract = chooseContract("system_health", responseContract, args);
    if (contract === null) {
      const before = totalChanges(ctx.db);
      try {
        return withBoundedBusyWait(ctx.db, () => refuseCall(ctx, "system_health", args, unsupportedContract()));
      } finally {
        trackedAuditChanges += Math.max(0, totalChanges(ctx.db) - before);
      }
    }

    // Scoped v2 contracts delegate to dispatchServeTool so v2 health rules stay centralized.
    if (contract !== ENVELOPE_SCHEMA) {
      const before = totalChanges(ctx.db);
      try {
        return await dispatchServeTool(ctx, "system_health", args, { response_contract: responseContract });
      } finally {
        trackedAuditChanges += Math.max(0, totalChanges(ctx.db) - before);
      }
    }

    const cacheKey =
      principal.kind === "owner"
        ? "owner:v1"
        : `agent:${principal.agent.agent_id}:${principal.grant_epoch}:v1`;
    const stamp = withBoundedBusyWait(ctx.db, () =>
      healthStateStamp(ctx.db, ctx.vaultPath, trackedAuditChanges),
    );
    const nowMs = Date.now();
    const cached = healthCache.get(cacheKey);
    if (cached !== undefined && nowMs - cached.atMs < HEALTH_SNAPSHOT_TTL_MS && cached.stamp === stamp) {
      const before = totalChanges(ctx.db);
      try {
        return withBoundedBusyWait(ctx.db, () =>
          gate(
            ctx,
            "system_health",
            auditArguments(args),
            () => ({ canon: [], quoted: [], withheld: [], data: structuredClone(cached.data) }),
            ENVELOPE_SCHEMA,
          ),
        );
      } finally {
        trackedAuditChanges += Math.max(0, totalChanges(ctx.db) - before);
      }
    }

    if (principal.kind === "owner") {
      let computedData: HealthData | undefined;
      const before = totalChanges(ctx.db);
      let envelope;
      try {
        envelope = withBoundedBusyWait(ctx.db, () =>
          gate(
            ctx,
            "system_health",
            auditArguments(args),
            ({ ctx: liveCtx }) => {
              const served = buildOwnerHealthServed(liveCtx);
              computedData = structuredClone(served.data);
              return served;
            },
            ENVELOPE_SCHEMA,
          ),
        );
      } finally {
        trackedAuditChanges += Math.max(0, totalChanges(ctx.db) - before);
      }
      if (computedData !== undefined) {
        const postStamp = withBoundedBusyWait(ctx.db, () =>
          healthStateStamp(ctx.db, ctx.vaultPath, trackedAuditChanges),
        );
        if (healthCache.size >= MAX_CACHED_PRINCIPALS) {
          healthCache.delete(healthCache.keys().next().value!);
        }
        healthCache.set(cacheKey, { stamp: postStamp, atMs: Date.now(), data: computedData });
      }
      return envelope;
    }

    const before = totalChanges(ctx.db);
    let envelope;
    try {
      envelope = await dispatchServeTool(ctx, "system_health", args, { response_contract: responseContract });
    } finally {
      trackedAuditChanges += Math.max(0, totalChanges(ctx.db) - before);
    }
    if ("data" in envelope && envelope.data !== undefined) {
      const postStamp = withBoundedBusyWait(ctx.db, () =>
        healthStateStamp(ctx.db, ctx.vaultPath, trackedAuditChanges),
      );
      if (healthCache.size >= MAX_CACHED_PRINCIPALS) {
        healthCache.delete(healthCache.keys().next().value!);
      }
      healthCache.set(cacheKey, {
        stamp: postStamp,
        atMs: Date.now(),
        data: structuredClone(envelope.data as HealthData),
      });
    }
    return envelope;
  };

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
      if (request.method === "GET" && url.pathname === "/v1/health") {
        const authHeader = request.headers.get("authorization");
        if (authHeader === null) {
          return json(200, { ok: true, bind: host, status: "ready" });
        }
        try {
          const presented = bearer(request);
          const principal = withBoundedBusyWait(options.db, () => principalFor(options.db, token, presented));
          if (principal === null) {
            return json(401, {
              ok: false,
              error: { code: "unauthorized", message: "missing or unknown bearer token", retryable: false },
            });
          }
          const responseContract = principal.kind === "agent" ? ENVELOPE_V2_SCHEMA : undefined;
          const envelope = await serveFastHealth(principal, {}, responseContract);
          return json(200, { ok: true, bind: host, status: "ready", value: envelope });
        } catch (error) {
          return refused(error);
        }
      }
      const presented = bearer(request);
      let principal: Principal | null;
      try {
        principal = withBoundedBusyWait(options.db, () => principalFor(options.db, token, presented));
      } catch (error) {
        return refused(error);
      }
      if (principal === null) {
        return json(401, {
          ok: false,
          error: { code: "unauthorized", message: "missing or unknown bearer token", retryable: false },
        });
      }
      const match = /^\/v1\/(?:mcp\/)?([a-z_]+)$/.exec(url.pathname);
      const rawTool = match?.[1];
      const tool = rawTool === "health" ? "system_health" : rawTool;
      if (request.method !== "POST" || tool === undefined || !(TOOLS as readonly string[]).includes(tool)) {
        return json(404, {
          ok: false,
          error: { code: "not_found", message: "unknown tool", retryable: false },
        });
      }
      let args: Record<string, unknown>;
      // The adapter selects the safe default; explicit legacy remains supported.
      let response_contract: unknown = principal.kind === "agent" ? ENVELOPE_V2_SCHEMA : undefined;
      try {
        const record = parseRequestObject(await readRequestText(request));
        if (Object.hasOwn(record, RESPONSE_CONTRACT_KEY)) {
          // Keep malformed selector wrappers whole so Core applies the same
          // closed-contract refusal as every other transport.
          response_contract = record[RESPONSE_CONTRACT_KEY];
          const wrapped = Object.keys(record).length === 2 && isPlainObject(record["args"]);
          args = wrapped ? record["args"] as Record<string, unknown> : record;
        } else if (Object.hasOwn(record, "args")) {
          if (!isPlainObject(record["args"])) throw new HttpBodyError(400);
          args = record["args"] as Record<string, unknown>;
        } else args = record;
      } catch (error) {
        return json(error instanceof HttpBodyError ? error.status : 400, {
          ok: false,
          error: { code: "config_invalid", message: "body must be bounded UTF-8 JSON object", retryable: false },
        });
      }
      try {
        if (tool === "system_health") {
          const envelope = await serveFastHealth(principal, args, response_contract);
          return json(200, { ok: true, value: envelope });
        }
        const envelope = await dispatchServeTool(
          { db: options.db, vaultPath: options.vaultPath, principal, servingSecrets: [token],
            ...(options.retrieval === undefined ? {} : { retrieval: options.retrieval }),
          },
          tool as Tool,
          args,
          { response_contract },
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
  if (presented === null || !sameToken(presented, token)) return error(401, "unauthorized");
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error(400, "invalid_request");
  try {
    const body = await readRequestText(request, MAX_APP_HTTP_BODY_BYTES);
    return reply(await options.handle(new Request(url, { method: "POST", headers: request.headers, body })));
  } catch (cause) { return error(cause instanceof HttpBodyError ? cause.status : 400, "invalid_request"); }
}
