import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  ENVELOPE_SCHEMA, EVENT_LIMITS, SERVE_PID_PATH, SERVE_TOKEN_PATH, ServeError, assertVaultControl, isPlainObject,
  readServeEndpoint, readServeProcessMarker,
  type serveHealth, type serveSearch, type serveWorldView,
} from "@kizuki/core";
import { ENVELOPE_V2_SCHEMA, isWorldWireToken, unsupportedContract, type EnvelopeV2 } from "@kizuki/core/world";
import { fetchTransport, type TransportRequest } from "@kizuki/llm";
import { configPath, readConfig } from "../config";
import { resolveVault } from "../context";
import { tokenResolver } from "../secrets";
import type { CliIo } from "./index";

type SearchResult = Awaited<ReturnType<typeof serveSearch<typeof ENVELOPE_SCHEMA>>>;
type HealthResult = ReturnType<typeof serveHealth<typeof ENVELOPE_SCHEMA>>;
type SearchRequest = Parameters<typeof serveSearch>[1];
const ENVELOPE_BYTES = 8 * 1024 * 1024;

function searchResponseBytes(args: SearchRequest): number {
  if (!args.full_text || args.scope === "canon") return ENVELOPE_BYTES;
  // One JSON escape can occupy six bytes per input byte of a full capture.
  const limit = Math.min(50, Math.max(1, args.limit ?? 20));
  return ENVELOPE_BYTES + limit * EVENT_LIMITS.textBytes * 6;
}

export interface DaemonReader {
  readonly vaultPath: string;
  search(args: SearchRequest): Promise<SearchResult>;
  searchV2(args: SearchRequest, contract: string): Promise<EnvelopeV2>;
  world(args: Parameters<typeof serveWorldView>[1]): Promise<ReturnType<typeof serveWorldView>>;
  health(): Promise<HealthResult>;
}

function currentEndpoint(vault: string) {
  const endpointFile = join(vault, ".kizuki", "serve.endpoint");
  const metadata = lstatSync(endpointFile, { throwIfNoEntry: false });
  if (!metadata) return undefined;
  assertVaultControl(vault, { repairPermissions: false });
  const pid = lstatSync(join(vault, SERVE_PID_PATH), { throwIfNoEntry: false });
  if (!pid) return undefined;
  for (const [stat, maxBytes] of [[metadata, 1024], [pid, 4096]] as const) {
    if (!stat.isFile() || stat.size > maxBytes || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("unsafe daemon discovery file");
  }
  const marker = readServeProcessMarker(vault);
  const endpoint = readServeEndpoint(vault, marker);
  return marker && endpoint ? { ...endpoint, instance: marker.instance_id } : undefined;
}

/** Bun selects its ambient proxy when fetch starts, before it yields. */
function postLoopback(request: TransportRequest, host: string) {
  const original = { no_proxy: process.env.no_proxy, NO_PROXY: process.env.NO_PROXY };
  const names = ["no_proxy", "NO_PROXY"] as const;
  try {
    for (const name of names) {
      const bypass = new Set((original[name] ?? "").split(/[,\s]+/).filter(Boolean));
      bypass.add(host === "::1" ? "[::1]" : host);
      process.env[name] = [...bypass].join(",");
    }
    return fetchTransport(request);
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
}

/** Bind reads to the current instance. A refusal from a live daemon must never replay locally. */
export function liveReadDaemon(io: CliIo): DaemonReader | undefined {
  const vaultPath = resolveVault(io.env, readConfig(configPath(io.env)), io.vaultOverride);
  const selected = currentEndpoint(vaultPath);
  if (!selected) return undefined;
  const { url, instance, host } = selected;
  function assertCurrent(): void {
    const current = currentEndpoint(vaultPath);
    if (current?.instance !== instance || current.url !== url) throw new Error("daemon endpoint changed during read; retry");
  }

  async function call(tool: "world_view" | "search" | "system_health", args: object, contract: string, maxBytes = ENVELOPE_BYTES): Promise<unknown> {
    const ref = `file:${join(vaultPath, SERVE_TOKEN_PATH)}`;
    const bearer = await tokenResolver(ref, io.env)(ref);
    if (!/^kzs_[A-Za-z0-9_-]{43}$/.test(bearer)) throw new Error("daemon read authorization refused");
    assertCurrent();
    const route = tool === "system_health" ? "health" : tool;
    const response = await postLoopback({
      url: `${url}/v1/${route}`, api_key: bearer, body: { args, response_contract: contract },
      timeout_ms: 10_000, max_response_bytes: maxBytes,
    }, host);
    assertCurrent();
    if (!response.ok) {
      if (response.kind === "http") {
        if (response.status === 400 && contract !== ENVELOPE_SCHEMA && contract !== ENVELOPE_V2_SCHEMA) throw unsupportedContract();
        if (response.status === 400 && tool === "world_view") throw new ServeError("invalid_arguments", "daemon refused world read");
        if (response.status === 401 || response.status === 403) throw new Error("daemon read authorization refused");
      }
      throw new Error("daemon read unavailable; retry");
    }
    const envelope = isPlainObject(response.body) && response.body.ok === true ? response.body.value : undefined;
    if (!isPlainObject(envelope) || envelope.schema !== contract || envelope.tool !== tool ||
        !Array.isArray(envelope.canon) || !Array.isArray(envelope.quoted) ||
        typeof envelope.at !== "string" ||
        (contract === ENVELOPE_SCHEMA && (envelope.principal !== "owner" || !Array.isArray(envelope.denied))) ||
        (contract === ENVELOPE_V2_SCHEMA && (!isPlainObject(envelope.principal) || envelope.principal.kind !== "principal" ||
          typeof envelope.principal.token !== "string" || !isWorldWireToken(envelope.principal.token))))
      throw new Error("invalid daemon read response");
    return envelope;
  }

  return {
    vaultPath,
    search: args => call("search", args, ENVELOPE_SCHEMA, searchResponseBytes(args)) as Promise<SearchResult>,
    searchV2: (args, contract) => call("search", args, contract, searchResponseBytes(args)) as Promise<EnvelopeV2>,
    world: args => call("world_view", args, ENVELOPE_V2_SCHEMA) as Promise<ReturnType<typeof serveWorldView>>,
    health: () => call("system_health", {}, ENVELOPE_SCHEMA) as Promise<HealthResult>,
  };
}
