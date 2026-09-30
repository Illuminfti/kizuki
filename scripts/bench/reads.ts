import { OWNER, type ServeContext } from "../../packages/core/src/index";
import { createServer } from "../../packages/mcp/src/index";
import { READS, distribution, type Metric, type Read } from "./report";
import { CLI, MCP, command } from "./process";

export function request(read: Read, pageId: string): { name: string; arguments: Record<string, unknown> } {
  switch (read) {
    case "search": return { name: "search", arguments: { query: "synthetic", scope: "all", limit: 10 } };
    case "context_session": return { name: "context_packet", arguments: { purpose: "session", budget_tokens: 1000 } };
    case "context_query": return { name: "context_packet", arguments: { purpose: "recall", query: "synthetic", budget_tokens: 1000 } };
    case "get_page": return { name: "get_page", arguments: { id: pageId } };
    case "timeline": return { name: "timeline", arguments: { since: "2020-01-01T00:00:00.000Z", until: "5000-01-01T00:00:00.000Z", limit: 10 } };
    case "world_discovery": return { name: "world_view", arguments: { operation: "find_concepts", label: "Topic" } };
    case "graph_neighbors": return { name: "graph_neighbors", arguments: { id: pageId, depth: 1 } };
  }
}

/** Refusals and empty fixtures must not be recorded as fast successful reads. */
export function assertRead(read: Read, result: unknown): void {
  if (result === null || typeof result !== "object") throw new Error("missing MCP result");
  const value = result as { isError?: boolean; structuredContent?: Record<string, unknown> };
  if (value.isError || value.structuredContent === undefined) throw new Error("MCP benchmark read refused");
  const envelope = value.structuredContent;
  const canon = envelope.canon as unknown[] | undefined, quoted = envelope.quoted as unknown[] | undefined;
  const data = envelope.data as Record<string, unknown> | undefined;
  if (read === "search" && !canon?.length && !quoted?.length) throw new Error("empty benchmark search");
  if (read === "get_page" && !canon?.length) throw new Error("empty benchmark page");
  if (read === "timeline" && !quoted?.length) throw new Error("empty benchmark timeline");
  const world = data?.result as { status?: string; data?: { matches?: unknown[] } } | undefined;
  if (read === "world_discovery" && !world?.data?.matches?.length) throw new Error(`empty world discovery (${world?.status ?? "missing"})`);
  if (read === "graph_neighbors" && !(data?.edges as unknown[] | undefined)?.length) throw new Error("empty benchmark graph");
  if (read.startsWith("context_") && (typeof data?.packet_md !== "string" || data.packet_md.length === 0 || (!canon?.length && !quoted?.length))) throw new Error("empty context packet");
}
export function assertCliRead(read: string, value: unknown): void {
  if (value === null || typeof value !== "object") throw new Error("missing CLI result");
  const envelope = value as { schema?: string; data?: Record<string, unknown> };
  const commandName = read === "search" ? "query" : read === "world_discovery" ? "world" : "context";
  if (envelope.schema !== `kizuki.cli.${commandName}/v1` || envelope.data === undefined) throw new Error("invalid CLI result");
  if (read === "search") {
    if (!(envelope.data.hits as unknown[] | undefined)?.length) throw new Error("empty CLI search");
  } else assertRead(read as Read, { structuredContent: envelope.data });
}
export async function measureReads(ctx: ServeContext, pageId: string, warmup: number, repetitions: number, processWarmup: number, processRepetitions: number): Promise<Record<string, Metric>> {
  const metrics: Record<string, Metric> = {};
  const server = createServer({ ...ctx, principal: OWNER });
  type Transport = Parameters<typeof server.connect>[0];
  type Message = Parameters<NonNullable<Transport["onmessage"]>>[0];
  let resolveResponse: ((value: unknown) => void) | undefined;
  let rejectResponse: ((error: Error) => void) | undefined;
  let id = 0;
  const transport: Transport = {
    start: async () => undefined, close: async () => undefined,
    send: async message => {
      if ("result" in message) resolveResponse?.(message.result);
      else if ("error" in message) rejectResponse?.(new Error("MCP request failed"));
    },
  };
  const rpc = (method: string, params: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    resolveResponse = resolve; rejectResponse = reject;
    transport.onmessage!({ jsonrpc: "2.0", id: ++id, method, params } as Message);
  });
  try {
    await server.connect(transport);
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic-benchmark", version: "1" } });
    transport.onmessage!({ jsonrpc: "2.0", method: "notifications/initialized" } as Message);
    await rpc("tools/list", {});
    for (const read of READS) {
      process.stderr.write(`benchmark: read ${read}\n`);
      const samples = [];
      for (let index = -warmup; index < repetitions; index++) {
        const started = performance.now();
        const result = await rpc("tools/call", request(read, pageId));
        const elapsed = performance.now() - started;
        assertRead(read, result);
        if (index >= 0) samples.push(elapsed);
      }
      metrics[`mcp.${read}.wall_ms`] = distribution("ms", samples);
      const cold = [];
      for (let index = -processWarmup; index < processRepetitions; index++) {
        const input = [
          { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic-benchmark", version: "1" } } },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: request(read, pageId) },
        ].map(message => JSON.stringify(message)).join("\n") + "\n";
        const measured = await command([MCP, "--vault", ctx.vaultPath, "--owner"], input);
        const response = measured.stdout.trim().split("\n").map(line => JSON.parse(line) as { id?: number; result?: unknown }).find(item => item.id === 2);
        assertRead(read, response?.result);
        if (index >= 0) cold.push(measured.wall_ms);
      }
      metrics[`cold_mcp.${read}.wall_ms`] = distribution("ms", cold);
    }
    for (const [read, args] of Object.entries({
      search: ["query", "synthetic", "--scope", "all", "--limit", "10", "--json"],
      context_session: ["context", "--purpose", "session", "--budget", "1000", "--json"],
      context_query: ["context", "--purpose", "recall", "--query", "synthetic", "--budget", "1000", "--json"],
      world_discovery: ["world", "--operation", "find_concepts", "--label", "Topic", "--json"],
    })) {
      const samples = [];
      for (let index = -processWarmup; index < processRepetitions; index++) {
        const result = await command([CLI, ...args, "--vault", ctx.vaultPath]);
        assertCliRead(read, JSON.parse(result.stdout));
        if (index >= 0) samples.push(result.wall_ms);
      }
      metrics[`cold_cli.${read}.wall_ms`] = distribution("ms", samples);
    }
    return metrics;
  } finally { await server.close(); }
}
