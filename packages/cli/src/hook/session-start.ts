import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createRedactor } from "@kizuki/core/internal";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  OWNER,
  SERVE_TOKEN_PATH,
  authenticate,
  authenticateAgentCredential,
  parseSecretRef,
  readAgentCredentialToken,
  readServeEndpoint,
  readServeProcessMarker,
  serveContextPacket,
} from "@kizuki/core";
import type { Principal } from "@kizuki/core";
import type { CliIo } from "../commands/index";
import { readConfig, configPath } from "../config";
import { resolveVault, withReadVault } from "../context";
import { cliArgs } from "../runtime";
import { tokenResolver } from "../secrets";

export const HARNESSES = ["claude-code", "codex", "generic"] as const;
export type Harness = (typeof HARNESSES)[number];

/** Why a hook printed nothing. Names a class of failure, never a path, token or captured text. */
const SKIPS = ["no_vault", "denied", "timeout", "empty", "unavailable", "oversized"] as const;
export type SkipReason = (typeof SKIPS)[number];

export type HookResult = { output: string } | { skip: SkipReason };

export interface SessionStartOptions {
  harness: Harness;
  budget: number;
  timeoutMs: number;
  tokenRef: string | undefined;
  /** Explicitly permit owner authority; output is still scrubbed for a harness. */
  owner?: boolean;
  /** Read the vault in this process and never call the daemon. */
  direct: boolean;
}

const MAX_STDIN_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
/** Includes the final stdout newline and any harness JSON framing. */
export const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
const MAX_QUERY_CHARS = 200;
const MAX_STDIN_WAIT_MS = 250;

/** The claude-code and codex hooks share one documented SessionStart output shape. */
export function formatHookOutput(harness: Harness, context: string): string {
  // A harness always gets agent-grade text, even when authorization was owner-level.
  const safe = createRedactor({ kind: "agent" }).text(context);
  return harness === "generic"
    ? safe
    : JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: safe } });
}

function outputFor(harness: Harness, context: string): HookResult {
  const output = formatHookOutput(harness, context);
  return Buffer.byteLength(output, "utf8") + 1 > MAX_HOOK_OUTPUT_BYTES
    ? { skip: "oversized" }
    : { output };
}

/** The project's own name from the hook's working directory. The path itself never leaves this function. */
export function projectQuery(input: string): string | undefined {
  let cwd: unknown;
  try { cwd = (JSON.parse(input) as { cwd?: unknown }).cwd; } catch { return undefined; }
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  const words = basename(cwd)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[_.\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const query = Array.from(words).slice(0, MAX_QUERY_CHARS).join("");
  return query.length === 0 ? undefined : query;
}

interface PacketLike {
  packet_md?: unknown;
  sections?: Record<string, unknown>;
  session?: Record<string, { served?: unknown }>;
  retrieval_degraded?: unknown;
}

/**
 * The packet text worth injecting, or null. A packet that could not be gathered,
 * or that carries no canon, capture, claim or session line, is nothing to inject.
 */
export function usableContext(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const packet = data as PacketLike;
  if (typeof packet.packet_md !== "string" || packet.packet_md.length === 0) return null;
  if (Array.isArray(packet.retrieval_degraded) && packet.retrieval_degraded.includes("context-unavailable")) return null;
  const served = [
    ...Object.values(packet.sections ?? {}),
    ...Object.values(packet.session ?? {}).map((section) => section?.served),
  ].some((count) => typeof count === "number" && count > 0);
  return served ? packet.packet_md : null;
}

function sleep(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), Math.max(0, ms)));
}

type Wire = { kind: "packet"; context: string } | { kind: "empty" } | { kind: "refused" } | { kind: "timeout" } | { kind: "unreachable" };

/** Direct loopback HTTP; Bun also needs NO_PROXY because its HTTP implementation uses fetch. */
async function callDaemon(url: string, bearer: string, body: object, ms: number): Promise<Wire> {
  if (ms <= 0) return { kind: "timeout" };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (wire: Wire): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(wire);
    };
    const request = httpRequest(`${url}/v1/context_packet`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    }, (response) => {
      if (response.statusCode !== 200) { finish({ kind: "refused" }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { finish({ kind: "refused" }); return; }
        chunks.push(chunk);
      });
      response.on("error", () => finish({ kind: "refused" }));
      response.on("end", () => {
        if (settled) return;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok?: unknown; value?: { data?: unknown } };
          if (parsed.ok !== true) { finish({ kind: "refused" }); return; }
          const context = usableContext(parsed.value?.data);
          finish(context === null ? { kind: "empty" } : { kind: "packet", context });
        } catch { finish({ kind: "refused" }); }
      });
    });
    const timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(1, ms));
    request.on("error", () => finish({ kind: "unreachable" }));
    request.end(JSON.stringify(body));
  });
}

/** The bearer the daemon expects for this caller, or null when none can be resolved. */
async function bearerFor(io: CliIo, vault: string, tokenRef: string | undefined): Promise<string | null> {
  try {
    if (tokenRef === undefined) return await tokenResolver(`file:${join(vault, SERVE_TOKEN_PATH)}`, io.env)(`file:${join(vault, SERVE_TOKEN_PATH)}`);
    const parsed = parseSecretRef(tokenRef);
    if (parsed?.scheme === "file") return readAgentCredentialToken(tokenRef);
    if (parsed?.scheme === "env") return await tokenResolver(tokenRef, io.env)(tokenRef);
  } catch { /* An unreadable credential is a denial, not a crash. */ }
  return null;
}

function principalFor(io: CliIo, db: Database, tokenRef: string | undefined): Principal | null {
  if (tokenRef === undefined) return OWNER;
  const parsed = parseSecretRef(tokenRef);
  if (parsed?.scheme === "file") return authenticateAgentCredential(db, tokenRef);
  const token = parsed?.scheme === "env" ? io.env[parsed.value] : undefined;
  return token === undefined ? null : authenticate(db, token);
}

async function readInProcess(io: CliIo, options: SessionStartOptions, request: object): Promise<HookResult> {
  const context = await withReadVault(io, async (ctx) => {
    const principal = principalFor(io, ctx.db, options.tokenRef);
    if (principal === null) return "denied" as const;
    const envelope = await serveContextPacket(
      {
        db: ctx.db,
        vaultPath: ctx.vaultPath,
        principal,
        ...(ctx.retrievalUnavailable ? { retrievalUnavailable: ctx.retrievalUnavailable } : {}),
      },
      request,
    );
    ctx.assertCurrent();
    return usableContext(envelope.data);
  }, { audit: true, retrieval: "none" });
  if (context === "denied") return { skip: "denied" };
  return context === null ? { skip: "empty" } : outputFor(options.harness, context);
}

/** Another copy of this CLI reads the vault, so a stalled read can be killed at the deadline. */
async function readInChild(io: CliIo, options: SessionStartOptions, vault: string, input: string, ms: number): Promise<HookResult> {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "XDG_CONFIG_HOME", "KIZUKI_CONFIG", "TMPDIR", "TEMP", "TMP"]) {
    const value = io.env[key];
    if (value !== undefined) env[key] = value;
  }
  const parsed = options.tokenRef === undefined ? null : parseSecretRef(options.tokenRef);
  let tokenRef = options.tokenRef;
  if (parsed?.scheme === "env") {
    const token = io.env[parsed.value];
    if (token === undefined) return { skip: "denied" };
    env.KIZUKI_HOOK_TOKEN = token;
    tokenRef = "env:KIZUKI_HOOK_TOKEN";
  }
  const child = Bun.spawn(
    cliArgs([
      "hook", "session-start", "--direct", "--verbose", "--vault", vault,
      "--harness", options.harness, "--budget", String(options.budget), "--timeout-ms", String(Math.max(100, Math.floor(ms))),
      ...(options.owner ? ["--owner"] : []),
      ...(tokenRef === undefined ? [] : ["--token-ref", tokenRef]),
    ]),
    { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  child.stdin.write(input);
  void child.stdin.end();
  const done = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const outcome = await Promise.race([done, sleep(ms)]);
  if (outcome === "timeout") {
    child.kill("SIGKILL");
    await done;
    return { skip: "timeout" };
  }
  const [stdout, stderr, code] = outcome;
  if (code !== 0) return { skip: "unavailable" };
  if (Buffer.byteLength(stdout) > MAX_HOOK_OUTPUT_BYTES) return { skip: "oversized" };
  if (stdout.trim().length > 0) return { output: stdout.replace(/\n$/, "") };
  // The child names its own reason on stderr; anything else it says is dropped.
  const reason = /^hook: nothing injected \((\w+)\)$/m.exec(stderr)?.[1];
  return { skip: SKIPS.includes(reason as SkipReason) ? (reason as SkipReason) : "unavailable" };
}

/**
 * One SessionStart hook run. Prefers the running daemon's loopback endpoint,
 * falls back to a direct read, and never throws: every failure is a skip.
 */
export async function runSessionStart(io: CliIo, options: SessionStartOptions): Promise<HookResult> {
  // Both cases matter: Bun gives the lower-case variable precedence. Preserve existing bypasses.
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const hosts = new Set((process.env[name] ?? "").split(/[,\s]+/).filter(Boolean));
    for (const host of ["127.0.0.1", "localhost", "::1"]) hosts.add(host);
    process.env[name] = [...hosts].join(",");
  }
  const started = Date.now();
  const remaining = (): number => options.timeoutMs - (Date.now() - started);
  try {
    if ((options.tokenRef === undefined && options.owner !== true) || (options.tokenRef !== undefined && options.owner === true)) return { skip: "denied" };
    // A harness that leaves stdin open must not spend the whole deadline: the query is a nicety, the packet is the point.
    let raw: string | "timeout" = "";
    if (io.readStdin !== undefined) {
      const pending = io.readStdin(MAX_STDIN_BYTES);
      raw = await Promise.race([pending, sleep(Math.min(MAX_STDIN_WAIT_MS, remaining() / 4))]);
      // A stalled host fires the timer in the same turn that delivers the bytes; one more turn lets ready input win.
      if (raw === "timeout") raw = await Promise.race([pending, sleep(0)]);
    }
    const input = raw === "timeout" ? "" : raw;
    const query = projectQuery(input);
    const request = { purpose: "session", budget_tokens: options.budget, ...(query === undefined ? {} : { query }) };

    let vault: string;
    try {
      vault = resolveVault(io.env, readConfig(configPath(io.env)), io.vaultOverride);
    } catch { return { skip: "no_vault" }; }
    if (!existsSync(join(vault, ".kizuki"))) return { skip: "no_vault" };

    if (options.direct) return await Promise.race([readInProcess(io, options, request), sleep(remaining()).then((): HookResult => ({ skip: "timeout" }))]);

    let marker = null;
    try { marker = readServeProcessMarker(vault); } catch { /* No readable marker means no daemon. */ }
    const endpoint = readServeEndpoint(vault, marker);
    const bearer = endpoint === null ? null : await bearerFor(io, vault, options.tokenRef);
    if (endpoint !== null && bearer !== null) {
      const wire = await callDaemon(endpoint.url, bearer, request, remaining());
      if (wire.kind === "packet") return outputFor(options.harness, wire.context);
      if (wire.kind === "empty") return { skip: "empty" };
      if (wire.kind === "timeout") return { skip: "timeout" };
      if (wire.kind === "refused") return { skip: "denied" };
    }
    if (remaining() <= 0) return { skip: "timeout" };
    return await readInChild(io, options, vault, input, remaining());
  } catch {
    return { skip: "unavailable" };
  }
}
