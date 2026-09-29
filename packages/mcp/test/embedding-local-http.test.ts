import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRetrievalDocuments } from "@kizuki/core";
import { createLocalHttpEmbeddingPort } from "@kizuki/embed-local-http";
import { openEmbeddedRetrievalPort } from "@kizuki/retrieval-pg";
import { startFakeServer } from "../../embed-local-http/test/helpers";
import type { FakeServer } from "../../embed-local-http/test/helpers";
import { SEMANTIC_DIMS, semanticVector } from "../../embed-local-http/test/semantic";
import { mcpFixture } from "./helpers";
import type { McpFixture } from "./helpers";

// Each test spawns the MCP server and opens the embedded SQL engine.
setDefaultTimeout(300_000);

const BIN = join(import.meta.dir, "..", "src", "bin.ts");
const ENGINE = "kizuki.retrieval.embedded-pg";

let fixture: McpFixture | null = null;
const servers: FakeServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  fixture?.dispose();
  fixture = null;
});

function configuration(server: FakeServer): Record<string, unknown> {
  return {
    api: "openai",
    endpoint: `http://127.0.0.1:${server.port}`,
    model: "synthetic-semantic",
    dims: SEMANTIC_DIMS,
    max_input_tokens: 512,
    timeout_ms: 5_000,
  };
}

/** A vault whose engine is built and whose serve.toml selects the engine and the local embedding server. */
async function indexed() {
  fixture = mcpFixture();
  const server = startFakeServer();
  server.embed = semanticVector;
  servers.push(server);
  writeFileSync(
    join(fixture.vaultPath, ".kizuki/serve.toml"),
    `[ports]
retrieval = "${ENGINE}"

[ports.embedding]
id = "kizuki.embedding.local-http"
api = "openai"
endpoint = "http://127.0.0.1:${server.port}"
model = "synthetic-semantic"
dims = ${SEMANTIC_DIMS}
max_input_tokens = 512
timeout_ms = 5000
`,
  );
  const dataDir = join(fixture.vaultPath, ".kizuki/retrieval", ENGINE);
  const embedding = createLocalHttpEmbeddingPort({
    vault_path: fixture.vaultPath,
    data_dir: join(fixture.vaultPath, ".kizuki/embedding/kizuki.embedding.local-http"),
    config: configuration(server),
    secrets: async () => { throw new Error("no secret"); },
    clock: () => new Date().toISOString(),
    logger: () => {},
  });
  const engine = await openEmbeddedRetrievalPort({
    vault_path: fixture.vaultPath, data_dir: dataDir, config: {},
    secrets: async () => { throw new Error("no secret"); },
    clock: () => new Date().toISOString(), logger: () => {},
  }, { embedding });
  try {
    await engine.rebuildFromDocuments(readRetrievalDocuments(fixture.db, fixture.vaultPath));
  } finally {
    await engine.close();
  }
  return { fixture, server };
}

interface Reply {
  code: number;
  messages: Array<{ id?: number; result?: { isError?: boolean; structuredContent?: { data?: Record<string, unknown> } } }>;
  stderr: string;
}

async function call(vault: McpFixture, requests: Array<{ name: string; arguments: Record<string, unknown> }>): Promise<Reply> {
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hybrid-proof", version: "0" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ...requests.map((request, at) => JSON.stringify({ jsonrpc: "2.0", id: at + 2, method: "tools/call", params: request })),
    "",
  ];
  const child = Bun.spawn([process.execPath, BIN, "--vault", vault.vaultPath, "--token-env", "KIZUKI_TEST_TOKEN"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, KIZUKI_TEST_TOKEN: vault.tokens["reader-personal"]! },
  });
  child.stdin.write(lines.join("\n"));
  child.stdin.end();
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, messages: stdout.trim().split("\n").map((line) => JSON.parse(line)), stderr };
}

const answer = (reply: Reply, id: number) => reply.messages.find((message) => message.id === id)?.result;

describe("kizuki-mcp with a configured local embedding server", () => {
  test("search and context_packet rank by vector and lose no vector lane", async () => {
    const { fixture: vault, server } = await indexed();
    const reply = await call(vault, [
      { name: "search", arguments: { query: "teapot", scope: "all" } },
      { name: "context_packet", arguments: { query: "teapot", purpose: "recall", budget_tokens: 1000 } },
    ]);
    expect(reply.code).toBe(0);
    const search = answer(reply, 2);
    expect(search?.isError).not.toBe(true);
    // Nothing in the vault says "teapot": only the vector lane can connect it to the kettle event.
    expect(JSON.stringify(search)).toContain("the public kettle is on");
    const degraded = (search?.structuredContent?.data?.["degraded"] ?? []) as string[];
    expect(degraded.filter((label) => label !== "index-degraded")).toEqual([]);
    const packet = answer(reply, 3);
    expect(packet?.isError).not.toBe(true);
    // Packets nominate canon pages only, and this vault serves none: an empty match is not a lost vector lane.
    const packetLabels = (packet?.structuredContent?.data?.["retrieval_degraded"] ?? []) as string[];
    expect(packetLabels).not.toContain("retrieval-vector-unavailable");
    expect(packetLabels).not.toContain("retrieval-unavailable");
    // Each call embedded its query once, on the loopback server and nowhere else.
    expect(server.requests.filter((request) => request.body.input[0] === "teapot")).toHaveLength(2);
    expect(reply.stderr).not.toContain("retrieval-unavailable");
  });

  test("with the embedding server down the session answers lexically and labels it", async () => {
    const { fixture: vault, server } = await indexed();
    server.stop();
    const reply = await call(vault, [
      { name: "search", arguments: { query: "kettle", scope: "all" } },
      { name: "search", arguments: { query: "teapot", scope: "all" } },
    ]);
    expect(reply.code).toBe(0);
    const keyword = answer(reply, 2);
    expect(JSON.stringify(keyword)).toContain("the public kettle is on");
    expect(keyword?.structuredContent?.data?.["degraded"]).toContain("retrieval-vector-unavailable");
    const paraphrase = answer(reply, 3);
    expect(JSON.stringify(paraphrase)).not.toContain("the public kettle is on");
    expect(paraphrase?.structuredContent?.data?.["degraded"]).toContain("retrieval-vector-unavailable");
  });
});
