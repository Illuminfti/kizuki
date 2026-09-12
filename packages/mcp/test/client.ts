import type { ServeContext } from "@kizuki/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";

export interface ToolCallResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

/**
 * Every connection a test opens is closed by the caller's `afterEach`: a
 * linked pair left open keeps the fixture's database handle alive.
 */
export async function connectClient(
  ctx: ServeContext,
  open: (() => Promise<void>)[],
): Promise<Client> {
  const server = createServer(ctx);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "kizuki-test", version: "0" });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.close();
    } finally {
      await server.close();
    }
  };
  open.push(close);
  let connected = false;
  try {
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    // A real client lists first; that is what builds the SDK's closed output
    // validator. Skipping it never notices a schema narrower than the envelope.
    await client.listTools();
    connected = true;
    return client;
  } finally {
    if (!connected) await close();
  }
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const result: unknown = await client.callTool({ name, arguments: args });
  return result as ToolCallResult;
}

export function envelopeOf(
  result: ToolCallResult,
): Record<string, unknown> {
  return result.structuredContent ?? {};
}

export function errorOf(result: ToolCallResult): { error?: string } {
  return JSON.parse(result.content[0]?.text ?? "{}") as { error?: string };
}

export function pageIds(envelope: Record<string, unknown>): string[] {
  return (envelope["canon"] as { page_id: string }[]).map(
    (chunk) => chunk.page_id,
  );
}
