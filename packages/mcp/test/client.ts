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
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
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
