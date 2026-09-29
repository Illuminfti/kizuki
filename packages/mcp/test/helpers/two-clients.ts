/**
 * The same world_view read for the owner (client A) and a scoped agent
 * (client B), each over its own real stdio MCP process on one vault, with the
 * audit rows both calls leave. Stdio is spoken as raw newline-delimited
 * JSON-RPC: the adapter package allows only the SDK's server and in-memory
 * entry points, so no SDK client transport is imported.
 */
import type { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_AGENT_GRANT, addAgent, listAudit } from "@kizuki/core";
import type { AuditRow, Grant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { tempVault } from "../../../core/test/helpers/vault";
import { worldSeed, type WorldSeed, type WorldSeedOptions } from "../../../core/test/helpers/world-seed";
import { envelopeOf } from "../client";
import type { ToolCallResult } from "../client";

const BIN = join(import.meta.dir, "..", "..", "src", "bin.ts");
const REQUEST_TIMEOUT_MS = 30_000;
const OUTPUT_BOUND = 1_048_576;

export interface StdioClient {
  call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

async function stdioClient(vault: string, selector: string[], env: Record<string, string>): Promise<StdioClient> {
  const child = Bun.spawn([process.execPath, BIN, "--vault", vault, ...selector], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), KIZUKI_SUPERVISOR: "none", ...env },
  });
  let next = 0;
  let closed = false;
  let terminal: Error | undefined;
  const pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();
  const diagnostics = new Response(child.stderr).text();
  const fail = (reason: string) => {
    terminal = new Error(`stdio client: ${reason}`);
    for (const waiting of pending.values()) waiting.reject(terminal);
    pending.clear();
  };
  const reading = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let total = 0;
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        const chunk = decoder.decode(read.value, { stream: true });
        total += chunk.length;
        if (total > OUTPUT_BOUND) throw new Error("bounded output exceeded");
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line === "") continue;
          const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (message.id === undefined) continue;
          const waiting = pending.get(message.id);
          pending.delete(message.id);
          if (message.error !== undefined) waiting?.reject(new Error(`stdio client: ${message.error.message ?? "protocol error"}`));
          else waiting?.resolve(message.result);
        }
      }
      fail("the process ended before replying");
    } catch (error) {
      fail(error instanceof Error ? error.message : "protocol failed");
      child.kill("SIGKILL");
    } finally {
      reader.releaseLock();
    }
  })();
  async function request(method: string, params: unknown): Promise<unknown> {
    if (terminal !== undefined) throw terminal;
    const id = ++next;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("stdio client: request timed out"));
        }, REQUEST_TIMEOUT_MS);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  const close = async () => {
    if (closed) return;
    closed = true;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await child.exited;
      await reading;
      await diagnostics;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "two-clients", version: "0" } });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  } catch (error) {
    await close();
    throw error;
  }
  return {
    async call(name, args) {
      return (await request("tools/call", { name, arguments: args })) as ToolCallResult;
    },
    close,
  };
}

export interface TwoClientsOptions {
  /** What to seed before either client connects. Default: one public concept. */
  readonly seed?: WorldSeedOptions;
  /** Grant patch for the scoped agent. Default: world_view only, public ceiling, the seeded subject. */
  readonly agent?: Partial<Grant>;
}

export interface TwoClients {
  readonly db: Database;
  readonly vaultPath: string;
  readonly seed: WorldSeed;
  readonly agentName: string;
  /** Bearer of the scoped agent, for the loopback endpoint. */
  readonly agentToken: string;
  readonly owner: StdioClient;
  readonly agent: StdioClient;
  /** Discover the concept, then read it: the same two world_view calls for either client. */
  readConcept(client: StdioClient, label?: string): Promise<{ discovery: Record<string, unknown>; card: Record<string, unknown> | null }>;
  /** Audit rows each principal's calls left, newest first. */
  audit(): { owner: AuditRow[]; agent: AuditRow[] };
  close(): Promise<void>;
}

export async function twoClients(options: TwoClientsOptions = {}): Promise<TwoClients> {
  const vault = tempVault("kizuki-two-clients-");
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  const clients: StdioClient[] = [];
  const close = async () => {
    for (const client of clients.splice(0).reverse()) await client.close();
    db.close();
    vault.dispose();
  };
  try {
    const seed = await worldSeed(db, options.seed);
    const agentName = "scoped-b";
    const subject = options.seed?.subject ?? "topic:bayes";
    const { token } = addAgent(db, agentName, {
      ...OWNER_AGENT_GRANT,
      ceiling: "public",
      subjects: [subject],
      tools: ["world_view"],
      ...options.agent,
    });
    const owner = await stdioClient(vault.path, ["--owner"], {});
    clients.push(owner);
    const agent = await stdioClient(vault.path, ["--token-env", "KIZUKI_AGENT_TOKEN"], { KIZUKI_AGENT_TOKEN: token });
    clients.push(agent);
    return {
      db,
      vaultPath: vault.path,
      seed,
      agentName,
      agentToken: token,
      owner,
      agent,
      async readConcept(client, label = seed.label) {
        const discovered = await client.call("world_view", {
          operation: "find_concepts",
          label,
          valid: { kind: "all" },
          knownAt: { kind: "current" },
        });
        const discovery = envelopeOf(discovered);
        const data = discovery.data as { result?: { data?: { matches?: { ref: unknown }[] } } };
        const ref = data.result?.data?.matches?.[0]?.ref;
        if (ref === undefined) return { discovery, card: null };
        const read = await client.call("world_view", {
          operation: "concept",
          concept: ref,
          valid: { kind: "all" },
          knownAt: { kind: "current" },
        });
        return { discovery, card: envelopeOf(read) };
      },
      audit: () => ({
        owner: listAudit(db, "owner", { limit: 20 }),
        agent: listAudit(db, agentName, { limit: 20 }),
      }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
