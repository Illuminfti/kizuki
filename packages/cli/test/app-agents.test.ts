import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listAgents, type AppAgentEnrollmentRequest } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { recordedPage } from "../../core/test/helpers/recorded-page";
import { AppAgentSetupError, enrollAppAgentSetup, resolveAppAgentMcpRuntime, revokeAppAgent, type AppAgentMcpConfiguration } from "../src/app/agents";
import { createHelpers } from "./helpers";

const helpers = createHelpers();
interface Session {
  pid: number;
  initialize(): Promise<void>;
  call(name: string, args: unknown): Promise<Reply>;
  close(): Promise<void>;
  transcript(): Promise<string>;
}
const sessions: Session[] = [];
afterEach(async () => { for (const child of sessions.splice(0)) await child.close(); helpers.cleanup(); });
const ENTRY = resolve(import.meta.dir, "../../mcp/src/bin.ts");
const request: AppAgentEnrollmentRequest = {
  name: "app-scoped-reader", operation_id: "app-stdio-0001",
  grant: { ceiling: "personal", types: ["fact"], subjects: ["person:ada"], since: null, until: null,
    tools: ["search"], rate_limit_per_minute: 60, relay_owner_corrections: false },
};

interface Reply { id?: number; result?: { isError?: boolean; content?: { text: string }[]; structuredContent?: unknown }; }
function session(config: AppAgentMcpConfiguration): Session {
  const child = Bun.spawn([config.command, ...config.args], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: helpers.tempDir("app-mcp-home-"), KIZUKI_SUPERVISOR: "none" },
  });
  const pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();
  let id = 0, stdout = "", closed = false, ended = false;
  const stderr = new Response(child.stderr).text();
  const reading = (async () => {
    const reader = child.stdout.getReader(), decoder = new TextDecoder(); let buffer = "";
    try {
      for (;;) {
        const read = await reader.read(); if (read.done) break;
        const text = decoder.decode(read.value, { stream: true }); stdout += text; buffer += text;
        if (stdout.length > 262_144) throw new Error("bounded MCP fixture output exceeded");
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
          const reply = JSON.parse(line) as Reply;
          if (reply.id !== undefined) { pending.get(reply.id)?.resolve(reply); pending.delete(reply.id); }
        }
      }
    } catch { child.kill("SIGKILL"); }
    finally {
      ended = true;
      for (const waiting of pending.values()) waiting.reject(new Error("MCP fixture ended before response"));
      pending.clear(); reader.releaseLock();
    }
  })();
  async function rpc(method: string, params: unknown) {
    if (ended) throw new Error("MCP fixture already ended");
    const next = ++id; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Reply>((resolve, reject) => {
        pending.set(next, { resolve, reject });
        timer = setTimeout(() => { pending.delete(next); reject(new Error("MCP fixture request timed out")); }, 10_000);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
      });
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const api = {
    pid: child.pid,
    async initialize() {
      expect((await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "app-onboarding-proof", version: "1" } })).result).toBeDefined();
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    },
    call(name: string, args: unknown) { return rpc("tools/call", { name, arguments: args }); },
    async close() {
      if (closed) return; closed = true; child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try { await child.exited; await reading; await stderr; } finally { clearTimeout(timer); }
    },
    async transcript() { return stdout + await stderr; },
  };
  sessions.push(api); return api;
}

function denied(reply: Reply, code: string) {
  expect(reply.result?.isError).toBe(true);
  expect(JSON.parse(reply.result?.content?.[0]?.text ?? "null").error).toBe(code);
  expect(reply.result?.structuredContent).toBeUndefined();
}

test("generated app setup launches the real scoped MCP and revokes access on that running process", async () => {
  const f = helpers.tempVault(); const db = openLedger(join(f.vault, ".kizuki/kizuki.db"));
  try {
    for (const page of [
      { path: "facts/allowed.md", id: "fact:allowed", type: "fact", sensitivity: "personal", subject: "person:ada", body: "orchard allowed synthetic note" },
      { path: "facts/private.md", id: "fact:private", type: "fact", sensitivity: "private", subject: "person:ada", body: "orchard PRIVATE_DENIED_CANARY" },
      { path: "facts/other-subject.md", id: "fact:other", type: "fact", sensitivity: "personal", subject: "person:grace", body: "orchard SUBJECT_DENIED_CANARY" },
      { path: "entities/other-type.md", id: "person:other", type: "person", sensitivity: "personal", subject: "person:ada", body: "orchard TYPE_DENIED_CANARY" },
    ]) await recordedPage(db, f.vault, page.path, { id: page.id, title: page.id, type: page.type, sensitivity: page.sensitivity,
      subjects: [page.subject], status: "active", taint: "clean" }, page.body);
    const setup = enrollAppAgentSetup(f.vault, request);
    expect(setup.receipt).toMatchObject({ status: "completed", authority: "active", credential: "ready", grant: request.grant });
    expect(setup.mcp?.command).toBe(process.execPath);
    const credential = join(f.vault, ".kizuki/agent-credentials/app-app-stdio-0001.json");
    expect(setup.mcp?.args).toEqual([ENTRY, "--vault", f.vault, "--token-ref", `file:${credential}`]);
    const token = (JSON.parse(readFileSync(credential, "utf8")) as { token: string }).token;
    expect(JSON.stringify(setup).includes(token), "browser projection excludes token bytes").toBe(false);
    expect(setup.mcp?.args).not.toContain("--owner"); expect(setup.mcp?.args).not.toContain("--token-env");
    const initial = lstatSync(credential);
    expect(enrollAppAgentSetup(f.vault, request).receipt.replayed).toBe(true);
    expect(lstatSync(credential).ino).toBe(initial.ino);
    const consumer = session(setup.mcp!); await consumer.initialize(); const pid = consumer.pid;
    const result = await consumer.call("search", { query: "orchard", scope: "canon" });
    expect(result.result?.isError).not.toBe(true);
    const output = JSON.stringify(result);
    expect(output.includes("orchard allowed synthetic note")).toBe(true);
    expect(/PRIVATE_DENIED_CANARY|SUBJECT_DENIED_CANARY|TYPE_DENIED_CANARY/.test(output)).toBe(false);
    denied(await consumer.call("get_page", { path: "facts/allowed.md" }), "tool_not_granted");
    expect(revokeAppAgent(f.vault, request.name).authority).toBe("revoked");
    denied(await consumer.call("search", { query: "orchard", scope: "canon" }), "unknown_agent");
    expect(consumer.pid).toBe(pid);
    expect(enrollAppAgentSetup(f.vault, request).mcp).toBeNull();
    expect(existsSync(credential)).toBe(true);
    await consumer.close();
    const transcript = await consumer.transcript();
    expect([token, credential, f.vault, "PRIVATE_DENIED_CANARY", "SUBJECT_DENIED_CANARY", "TYPE_DENIED_CANARY"].some(value => transcript.includes(value)), "MCP output redaction").toBe(false);
    expect(listAgents(db).map(agent => ({ name: agent.name, grant: agent.grant, revoked: agent.revoked_at !== null }))).toEqual([{ name: request.name, grant: request.grant, revoked: true }]);
  } finally { db.close(); }
}, 30_000);

test("compiled MCP configuration uses the verified installed sibling without executing preflight", () => {
  const root = helpers.tempDir("app-compiled-runtime-"), candidate = join(root, "kizuki-mcp"), marker = join(root, "executed");
  writeFileSync(candidate, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  const runtime = { compiled: true, executable: join(root, "kizuki"), sourceEntrypoint: "/unused-entrypoint" };
  expect(resolveAppAgentMcpRuntime(runtime)).toEqual({ command: candidate, args: [] });
  expect(existsSync(marker)).toBe(false);
  chmodSync(candidate, 0o600);
  expect(() => resolveAppAgentMcpRuntime(runtime)).toThrow(AppAgentSetupError);
});

test("missing runtime components refuse before creating an agent or credential directory", () => {
  const f = helpers.tempVault();
  for (const runtime of [
    { compiled: false, executable: process.execPath, sourceEntrypoint: join(f.root, "absent-entrypoint") },
    { compiled: false, executable: f.root, sourceEntrypoint: ENTRY },
    { compiled: true, executable: join(f.root, "kizuki"), sourceEntrypoint: ENTRY },
  ]) {
    let caught: unknown;
    try { enrollAppAgentSetup(f.vault, request, runtime); } catch (error) { caught = error; }
    expect(caught instanceof AppAgentSetupError).toBe(true);
    expect((caught as Error)?.message).toBe("mcp_unavailable");
  }
  expect(existsSync(join(f.vault, ".kizuki/agent-credentials"))).toBe(false);
  const db = openLedger(join(f.vault, ".kizuki/kizuki.db"));
  try { expect(listAgents(db)).toEqual([]); } finally { db.close(); }
});
