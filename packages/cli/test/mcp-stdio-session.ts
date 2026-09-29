import { expect } from "bun:test";
import { resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "../../mcp/src/bin.ts");

export interface McpReply {
  result?: { isError?: boolean; content?: { text: string }[]; structuredContent?: unknown };
}

/** One real stdio MCP process launched the way a client launches it: vault and credential file reference only. */
export function openMcpSession(vault: string, tokenRef: string, home: string) {
  const child = Bun.spawn([process.execPath, ENTRY, "--vault", vault, "--token-ref", tokenRef], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: home, KIZUKI_SUPERVISOR: "none" },
  });
  const pending = new Map<number, (reply: McpReply & { id?: number }) => void>();
  let id = 0, closed = false;
  const stderr = new Response(child.stderr).text();
  const reading = (async () => {
    const reader = child.stdout.getReader(), decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const read = await reader.read(); if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line) continue;
        const reply = JSON.parse(line) as McpReply & { id?: number };
        if (reply.id !== undefined) { pending.get(reply.id)?.(reply); pending.delete(reply.id); }
      }
    }
  })();
  const rpc = (method: string, params: unknown) => new Promise<McpReply>((resolveReply, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error("MCP request timed out")); }, 15_000);
    pending.set(next, reply => { clearTimeout(timer); resolveReply(reply); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
  });
  return {
    async initialize() {
      expect((await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grant-proof", version: "1" } })).result).toBeDefined();
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    },
    call: (name: string, args: unknown) => rpc("tools/call", { name, arguments: args }),
    async close() {
      if (closed) return; closed = true; child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try { await child.exited; await reading; await stderr; } finally { clearTimeout(timer); }
    },
  };
}
