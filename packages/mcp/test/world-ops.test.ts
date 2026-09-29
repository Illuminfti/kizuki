import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { withWorldOps } from "@kizuki/core/testing";
import { WORLD_OPS, readWorldView, worldOpInputKeys } from "@kizuki/core/world";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { PING_SCHEMA, pingOp } from "../../core/test/serving/world-test-op";
import { MCP_WORLD_OPS } from "../src/world/ops";
import type { McpWorldOp } from "../src/world/ops";
import { createServer } from "../src/server";
import { buildWorldSurface } from "../src/world/surface";
import { call, envelopeOf } from "./client";
import { mcpFixture } from "./helpers";
import type { McpFixture } from "./helpers";

setDefaultTimeout(60_000);

let fixture: McpFixture | null = null;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  fixture?.dispose();
  fixture = null;
});

const pingFragment: McpWorldOp = {
  name: "ping",
  fields: { text: z.string().max(40).optional() },
  data: { [PING_SCHEMA]: { echo: z.string(), inTransaction: z.boolean() } },
  summary: 'ping echoes {text}',
};

async function connect(worldOps?: readonly McpWorldOp[]): Promise<Client> {
  fixture = mcpFixture();
  const server = createServer(fixture.owner(), worldOps === undefined ? {} : { worldOps });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "kizuki-test", version: "0" });
  open.push(async () => {
    await client.close();
    await server.close();
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  await client.listTools();
  return client;
}

interface Property {
  enum?: string[];
}
async function listed(client: Client) {
  const tool = (await client.listTools()).tools.find((entry) => entry.name === "world_view");
  const schema = tool?.inputSchema as { properties?: Record<string, Property> };
  return { tool, schema };
}

describe("the MCP fragments", () => {
  test("cover exactly the registered operations, with the data schema ids the core declares", () => {
    expect(MCP_WORLD_OPS.map((op) => op.name)).toEqual(WORLD_OPS.map((op) => op.name));
    for (const op of WORLD_OPS) {
      const fragment = MCP_WORLD_OPS.find((entry) => entry.name === op.name);
      expect(fragment, op.name).toBeDefined();
      expect(Object.keys(fragment!.data).sort()).toEqual([...op.dataSchemas].sort());
    }
  });
});

describe("the surface builder", () => {
  test("refuses a field that would make every other operation fail, or one two operations declare differently", () => {
    expect(() => buildWorldSurface([...MCP_WORLD_OPS, { ...pingFragment, fields: { text: z.string() } }])).toThrow(/optional or defaulted/);
    expect(() => buildWorldSurface([...MCP_WORLD_OPS, { ...pingFragment, fields: { label: z.string().optional() } }])).toThrow(/more than once/);
    expect(() => buildWorldSurface([...MCP_WORLD_OPS, pingFragment, pingFragment])).toThrow(/twice/);
  });
});

describe("world_view as generated from the registry", () => {
  test("advertises the registered operations as its enum and no key beyond theirs", async () => {
    const { schema } = await listed(await connect());
    expect(schema.properties?.["operation"]?.enum).toEqual(WORLD_OPS.map((op) => op.name));
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      ["concept", "cursor", "knownAt", "label", "operation", "situation", "valid"],
    );
  });

  test("describe answers over MCP with the bytes Core gives, though the SDK fills valid and knownAt", async () => {
    const client = await connect();
    const answered = await call(client, "world_view", { operation: "describe" });
    expect(answered.isError ?? false).toBe(false);
    const data = (envelopeOf(answered)["data"] as { result: { data: unknown } }).result.data;
    const direct = readWorldView(fixture!.owner(), { operation: "describe" });
    if ("status" in direct || direct.result.status !== "current") throw new Error("describe failed");
    expect(JSON.stringify(data)).toBe(JSON.stringify(direct.result.data));
  });

  test("describe takes the common keys as Core does: explicit defaults are the same call, a past cutoff is unavailable", async () => {
    const client = await connect();
    const bare = envelopeOf(await call(client, "world_view", { operation: "describe" }));
    const explicit = await call(client, "world_view", {
      operation: "describe",
      valid: { kind: "all" },
      knownAt: { kind: "current" },
    });
    expect(explicit.isError ?? false).toBe(false);
    expect(JSON.stringify(envelopeOf(explicit)["data"])).toBe(JSON.stringify(bare["data"]));
    const direct = readWorldView(fixture!.owner(), { operation: "describe", valid: { kind: "all" }, knownAt: { kind: "current" } });
    expect(JSON.stringify(direct)).toBe(JSON.stringify(bare["data"]));
    const past = await call(client, "world_view", { operation: "describe", knownAt: { kind: "time", at: "2026-01-01T00:00:00.000Z" } });
    expect(envelopeOf(past)["data"]).toMatchObject({ operation: "describe", result: { status: "unavailable", reason: "history" } });
  });

  test("the fragments name the same own keys as the core operations", () => {
    const common = ["operation", "valid", "knownAt"];
    for (const op of WORLD_OPS) {
      const fragment = MCP_WORLD_OPS.find((entry) => entry.name === op.name);
      const own = worldOpInputKeys(op).filter((key) => !common.includes(key));
      expect(Object.keys(fragment?.fields ?? {}).sort(), op.name).toEqual([...own].sort());
    }
  });

  test("a test-only operation with one fragment is listed and answered with no edit to the server", async () => {
    await withWorldOps([pingOp], async () => {
      const client = await connect([...MCP_WORLD_OPS, pingFragment]);
      const { tool, schema } = await listed(client);
      expect(schema.properties?.["operation"]?.enum).toEqual([...WORLD_OPS.map((op) => op.name), "ping"]);
      expect(Object.keys(schema.properties ?? {})).toContain("text");
      expect(tool?.description).toContain("ping echoes {text}");
      const answered = await call(client, "world_view", { operation: "ping", text: "hi" });
      expect(answered.isError ?? false).toBe(false);
      expect(envelopeOf(answered)["data"]).toMatchObject({
        operation: "ping",
        result: { status: "current", data: { schema: PING_SCHEMA, echo: "hi", inTransaction: true } },
      });
      const wrong = await call(client, "world_view", { operation: "ping" });
      expect(wrong.isError).toBe(true);
    });
  });

  test("an operation the core registers but no fragment advertises cannot be called through MCP", async () => {
    await withWorldOps([pingOp], async () => {
      const client = await connect();
      const answered = await call(client, "world_view", { operation: "ping", text: "hi" });
      expect(answered.isError).toBe(true);
    });
  });

  test("the listing stays inside its size guard", async () => {
    const client = await connect();
    const all = await client.listTools();
    expect(Buffer.byteLength(JSON.stringify(all))).toBeLessThan(40 * 1024);
    const { tool } = await listed(client);
    expect(Buffer.byteLength(JSON.stringify(tool?.outputSchema))).toBeLessThan(4 * 1024);
  });
});
