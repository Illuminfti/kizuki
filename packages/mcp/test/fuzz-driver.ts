import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ServeContext } from "@kizuki/core";
import { createServer } from "../src/server";

/** Real SDK validation and core dispatch, using an offline protocol pair. */
export async function mcpFuzzDriver(ctx: ServeContext) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(ctx);
  const client = new Client({ name: "synthetic-fuzz-client", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    async call(name: string, args: unknown): Promise<unknown> {
      try {
        return await client.callTool({ name, arguments: args as Record<string, unknown> });
      } catch (error) {
        // Non-object arguments are rejected as JSON-RPC InvalidParams, rather
        // than a tool result. Do not suppress output validation or other faults.
        const invalidContainer = args === null || typeof args !== "object" || Array.isArray(args);
        if (invalidContainer && error instanceof Error && error.name === "McpError" &&
          (error as Error & { code?: unknown }).code === -32602) return { isError: true, protocolRefusal: true };
        throw error;
      }
    },
    async close() { await client.close(); await server.close(); },
  };
}

/** Exercise raw JSON-RPC framing as well as the object transport used for calls. */
export async function fuzzStdioBytes(ctx: ServeContext, bytes: Uint8Array): Promise<void> {
  const input = new PassThrough(), output = new PassThrough();
  const server = createServer(ctx);
  const transport = new StdioServerTransport(input, output);
  let unexpected = false, size = 0, pending = "";
  let acknowledge: (() => void) | undefined;
  server.server.onerror = (error) => {
    if (!(error instanceof SyntaxError) && error.name !== "ZodError" && error.name !== "McpError") unexpected = true;
  };
  output.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 1024 * 1024) { unexpected = true; return; }
    pending += chunk.toString("utf8");
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      try {
        const message = JSON.parse(pending.slice(0, end)) as { id?: number };
        if (message.id === 9001) acknowledge?.();
      } catch { unexpected = true; }
      pending = pending.slice(end + 1);
    }
  });
  try {
    await server.connect(transport);
    const replied = new Promise<void>(resolve => { acknowledge = resolve; });
    input.write(Buffer.concat([bytes, Buffer.from("\n")]));
    input.write('{"jsonrpc":"2.0","id":9001,"method":"ping"}\n');
    await replied;
    if (unexpected || pending.length > 4096) throw new Error("unexpected-stdio-response");
  } finally { await server.close(); input.destroy(); output.destroy(); }
}
