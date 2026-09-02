import { afterEach, describe, expect, test } from "bun:test";
import { TOOLS } from "@kizuki/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, connectClient, envelopeOf } from "./client";
import { mcpFixture } from "./helpers";
import type { McpFixture } from "./helpers";

let fixture: McpFixture | null = null;
const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
  fixture?.dispose();
  fixture = null;
});

function live(): McpFixture {
  fixture = mcpFixture();
  return fixture;
}

/**
 * The SDK client builds an output validator from `tools/list` and applies it
 * to every later result, so a schema narrower than the envelope is a protocol
 * error the caller cannot work around. Listing first is what a real client
 * does; a test that skips it never builds the validator.
 */
async function listed(fix: McpFixture): Promise<Client> {
  const client = await connectClient(fix.owner(), open);
  await client.listTools();
  return client;
}

describe("the advertised output schema describes what the server sends", () => {
  test("a validating client accepts every canon-returning tool", async () => {
    const running = live();
    const client = await listed(running);

    for (const [name, args] of [
      ["search", { query: "kettle" }],
      ["get_page", { id: "person:ada" }],
      ["query_entities", { type: "person" }],
      ["context_packet", { query: "kettle" }],
      ["timeline", { day: "2026-02-28" }],
      ["graph_neighbors", { id: "person:ada" }],
      ["system_health", {}],
    ] as const) {
      const result = await call(client, name, args);
      expect(result.isError ?? false).toBe(false);
    }
  });

  test("the canon chunk schema carries the trust fields the engine emits", async () => {
    const running = live();
    const client = await connectClient(running.owner(), open);
    const tools = (await client.listTools()).tools;

    const advertised = tools.find((tool) => tool.name === "get_page");
    const canon = (
      advertised?.outputSchema as {
        properties?: {
          canon?: { items?: { required?: string[]; properties?: object } };
        };
      }
    ).properties?.canon?.items;
    expect(canon?.required).toContain("taint");
    expect(canon?.required).toContain("authority");

    const chunk = (
      envelopeOf(await call(client, "get_page", { id: "person:ada" }))[
        "canon"
      ] as Record<string, unknown>[]
    )[0];
    expect(chunk).toBeDefined();
    // Whatever the engine puts on a chunk is described; nothing is advertised
    // that the engine never sends.
    expect(Object.keys(chunk ?? {}).sort()).toEqual(
      [...(canon?.required ?? [])].sort(),
    );
  });

  test("every tool advertises an output schema", async () => {
    const client = await connectClient(live().owner(), open);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual([...TOOLS]);
    for (const tool of tools) expect(tool.outputSchema).toBeDefined();
  });
});
