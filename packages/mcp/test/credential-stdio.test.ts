import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { enrollAgent, revokeAgentEnrollment, setGrant, type Grant } from "@kizuki/core";
import { mcpFixture, type McpFixture } from "./helpers";

const BIN = join(import.meta.dir, "../src/bin.ts");
let fixture: McpFixture | undefined;
interface Session {
  initialize(): Promise<void>;
  call(name: string, args: unknown): Promise<Reply>;
  close(): Promise<void>;
  transcript(): Promise<string>;
  readonly pid: number;
}
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(child => child.close()));
  fixture?.dispose(); fixture = undefined;
});

// Inspect the runner independently of the implementation. Qualified CI must
// exercise the actual positive process path, never skip because an API threw.
const qualified = process.platform === "linux" && process.arch === "x64" && (() => {
  const uid = process.geteuid?.();
  if (uid === undefined) return false;
  for (let path = tmpdir();; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid) ||
      ((stat.mode & 0o022) !== 0 && (stat.uid !== 0 || (stat.mode & 0o1000) === 0))) return false;
    if (path === dirname(path)) return true;
  }
})();

interface Reply { id?: number; result?: { isError?: boolean; content?: { text: string }[]; structuredContent?: unknown }; }

function session(args: string[]): Session {
  const child = Bun.spawn([process.execPath, BIN, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), KIZUKI_SUPERVISOR: "none" } });
  let next = 0, stdout = "", stopped = false, closed = false, terminal: Error | undefined;
  const pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();
  const diagnostics = new Response(child.stderr).text();
  function fail(reason = "protocol failed") {
    terminal = new Error(`MCP fixture ${reason}`);
    for (const waiting of pending.values()) waiting.reject(terminal);
    pending.clear();
  }
  const reading = (async () => {
    const reader = child.stdout.getReader(), decoder = new TextDecoder(); let buffer = "";
    try {
      for (;;) {
        const read = await reader.read(); if (read.done) break;
        const chunk = decoder.decode(read.value, { stream: true }); stdout += chunk; buffer += chunk;
        if (stdout.length > 262_144) throw new Error("bounded fixture output exceeded");
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line) continue;
          const message = JSON.parse(line) as Reply;
          if (message.id !== undefined) { pending.get(message.id)?.resolve(message); pending.delete(message.id); }
        }
      }
      if (buffer.trim() || pending.size) {
        const diagnostic = await diagnostics;
        const reason = ["vault could not open", "credential not recognized", "retrieval port could not start"].find(text => diagnostic.includes(text));
        fail(reason ?? "protocol ended before replying");
      }
    } catch { fail(); child.kill("SIGKILL"); }
    finally { stopped = true; reader.releaseLock(); }
  })();
  async function request(method: string, params: unknown): Promise<Reply> {
    if (terminal || stopped) throw new Error("MCP fixture process ended");
    const id = ++next;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Reply>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP fixture request timed out")); }, 10_000);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const handle = {
    async initialize() {
      const reply = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "credential-proof", version: "1" } });
      expect(reply.result).toBeDefined();
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    },
    call(name: string, args: unknown) { return request("tools/call", { name, arguments: args }); },
    async close() {
      if (closed) return;
      closed = true;
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try { await child.exited; await reading; await diagnostics; } finally { clearTimeout(timer); }
    },
    async transcript() { return stdout + await diagnostics; },
    get pid() { return child.pid; },
  };
  sessions.push(handle); return handle;
}

function privateFixture(): McpFixture {
  const f = mcpFixture();
  // Core's bare DB helper creates an ordinary SQLite fixture; enrollment
  // requires the private custody established by the real CLI init path.
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = join(f.vaultPath, ".kizuki", `kizuki.db${suffix}`);
    if (existsSync(path)) chmodSync(path, 0o600);
  }
  return f;
}

async function refusal(args: string[]) {
  const child = Bun.spawn([process.execPath, BIN, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: tmpdir() } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timer); }
}

function denied(reply: Reply, code: string): void {
  expect(reply.result?.isError).toBe(true);
  expect(JSON.parse(reply.result?.content?.[0]?.text ?? "null").error).toBe(code);
  expect(reply.result?.structuredContent).toBeUndefined();
}

test.if(process.env.GITHUB_ACTIONS === "true" && process.platform === "linux" && process.arch === "x64")("file credential stdio proof requires qualified Linux CI custody", () => {
  expect(qualified).toBe(true);
});

test("MCP rejects ambiguous credential selectors without echoing values or falling back to owner", async () => {
  for (const args of [["--owner", "--token-ref", "file:/private-marker"],
    ["--token-env", "ENV_MARKER", "--token-ref", "file:/private-marker"],
    ["--token-ref", "file:/private-marker", "--token-ref", "file:/second-marker"]]) {
    const result = await refusal(["--vault", "/absent-vault-marker", ...args]);
    expect(result.code).toBe(2); expect(result.stdout).toBe("");
    expect(/private-marker|second-marker|ENV_MARKER|absent-vault-marker/.test(result.stderr)).toBe(false);
  }
});

test.if(qualified)("two live file-credential processes and reconnects use current Core grants and revocation", async () => {
  fixture = privateFixture();
  const directory = join(fixture.vaultPath, ".kizuki", "agent-credentials"); mkdirSync(directory, { mode: 0o700 });
  const credential = join(directory, "client.credential");
  const grant: Grant = { ceiling: "personal", types: null, subjects: ["person:ada"], since: null, until: null,
    tools: ["search"], rate_limit_per_minute: 60, relay_owner_corrections: false };
  const enrolled = enrollAgent(fixture.vaultPath, { name: "file-client", operation_id: "stdio-client-1", token_ref: `file:${credential}`, grant });
  expect(enrolled.authority).toBe("active");
  const token = (JSON.parse(readFileSync(credential, "utf8")) as { token: string }).token;
  const args = ["--vault", fixture.vaultPath, "--token-ref", `file:${credential}`];
  const one = session(args), two = session(args);
  expect(one.pid).not.toBe(two.pid);
  await Promise.all([one.initialize(), two.initialize()]);
  const search = { query: "kettle", scope: "all" };
  for (const reply of await Promise.all([one.call("search", search), two.call("search", search)])) {
    const outcome = reply.result?.isError ? JSON.parse(reply.result.content?.[0]?.text ?? "{}").error : "allowed";
    expect(outcome).toBe("allowed");
    expect(JSON.stringify(reply)).toContain("Ada keeps the kettle warm");
    expect(JSON.stringify(reply).includes("private kettle protocol")).toBe(false);
  }
  denied(await one.call("get_page", { path: "facts/kettle-private.md" }), "tool_not_granted");
  setGrant(fixture.db, "file-client", { subjects: [] });
  for (const reply of await Promise.all([one.call("search", search), two.call("search", search)])) {
    expect(reply.result?.isError).not.toBe(true);
    expect(JSON.stringify(reply).includes("Ada keeps the kettle warm")).toBe(false);
  }
  setGrant(fixture.db, "file-client", { tools: [] });
  denied(await one.call("search", search), "tool_not_granted");
  denied(await two.call("search", search), "tool_not_granted");
  const reconnect = session(args); await reconnect.initialize();
  denied(await reconnect.call("search", search), "tool_not_granted");
  expect(revokeAgentEnrollment(fixture.vaultPath, "file-client").authority).toBe("revoked");
  denied(await one.call("search", search), "unknown_agent");
  denied(await two.call("search", search), "unknown_agent");
  const revoked = await refusal(args);
  expect(revoked.code).toBe(1); expect(revoked.stdout).toBe("");
  expect(revoked.stderr.trim()).toBe("credential not recognized");
  await Promise.all([one.close(), two.close(), reconnect.close()]);
  for (const child of [one, two, reconnect]) {
    const transcript = await child.transcript();
    expect([token, credential, fixture.vaultPath].some(value => transcript.includes(value)), "MCP output redaction").toBe(false);
  }
}, 30_000);

test.if(qualified)("copied or malformed credential files refuse with one generic startup error", async () => {
  fixture = privateFixture();
  const directory = join(fixture.vaultPath, ".kizuki", "agent-credentials"); mkdirSync(directory, { mode: 0o700 });
  const credential = join(directory, "original.credential"), copy = join(directory, "copy.credential");
  const grant: Grant = { ceiling: "public", types: [], subjects: [], since: null, until: null, tools: [], rate_limit_per_minute: 1, relay_owner_corrections: false };
  enrollAgent(fixture.vaultPath, { name: "inert-file", operation_id: "stdio-copy-test", token_ref: `file:${credential}`, grant });
  copyFileSync(credential, copy);
  for (const path of [copy, credential]) {
    if (path === credential) writeFileSync(path, "private-invalid-envelope-marker");
    const output = await refusal(["--vault", fixture.vaultPath, "--token-ref", `file:${path}`]);
    expect(output.code).toBe(1); expect(output.stdout).toBe("");
    expect(output.stderr.trim()).toBe("credential not recognized");
  }
});
