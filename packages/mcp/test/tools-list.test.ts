import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TOOLS, listAudit, revokeAgent, setGrant } from "@kizuki/core";
import { worldFixture } from "../../core/test/serving/world-fixture";
import { WORLD_ENVELOPE, WORLD_ENVELOPE_LISTED, WORLD_VIEW_INPUT } from "../src/schemas";
import { z } from "zod";
import { call, connectClient, envelopeOf, errorOf } from "./client";
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

function live(): McpFixture {
  fixture = mcpFixture();
  return fixture;
}

interface Property {
  type?: string;
  enum?: string[];
  default?: unknown;
}

describe("world_view as a client sees it", () => {
  test("tools/list advertises the operation and its fields with their defaults", async () => {
    const client = await connectClient(live().owner(), open);
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "world_view");
    const schema = tool?.inputSchema as { properties?: Record<string, Property>; required?: string[] };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      ["concept", "knownAt", "label", "operation", "situation", "valid"],
    );
    expect(schema.properties?.["operation"]?.enum).toEqual(["find_concepts", "find_situations", "concept", "situation"]);
    expect(schema.required).toEqual(["operation"]);
    expect(schema.properties?.["label"]?.default).toBe("");
    expect(schema.properties?.["valid"]?.default).toEqual({ kind: "all" });
    expect(schema.properties?.["knownAt"]?.default).toEqual({ kind: "current" });
  });

  test("an operation alone discovers, and an operation with its object token reads", async () => {
    const running = live();
    await worldFixture(running.db);
    const client = await connectClient(running.owner(), open);

    const discovered = await call(client, "world_view", { operation: "find_concepts" });
    expect(discovered.isError ?? false).toBe(false);
    const matches = (envelopeOf(discovered)["data"] as {
      result: { data: { matches: { ref: { kind: "object"; token: string } }[] } };
    }).result.data.matches;
    expect(matches.length).toBeGreaterThan(0);

    const read = await call(client, "world_view", { operation: "concept", concept: matches[0]!.ref });
    expect(read.isError ?? false).toBe(false);
    expect(JSON.stringify(envelopeOf(read))).toContain("Revise beliefs using evidence");
  });

  test("a label given to a read, and a read without its token, are refused by the engine and audited", async () => {
    const running = live();
    const client = await connectClient(running.agent("reader-private"), open);
    const token = "A".repeat(42) + "A";
    const ref = { kind: "object", token };

    const labelled = await call(client, "world_view", { operation: "concept", concept: ref, label: "x" });
    expect(labelled.isError).toBe(true);
    expect(errorOf(labelled).error).toBe("invalid_arguments");
    const bare = await call(client, "world_view", { operation: "situation" });
    expect(bare.isError).toBe(true);
    expect(errorOf(bare).error).toBe("invalid_arguments");
    const crossed = await call(client, "world_view", { operation: "find_situations", concept: ref });
    expect(errorOf(crossed).error).toBe("invalid_arguments");

    const rows = listAudit(running.db, "reader-private", { limit: 10 }).filter((row) => row.tool === "world_view");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.denied).toEqual([{ id: "tool:world_view", reason: "invalid_arguments" }]);
  });

  test("a call the grant does not allow reaches the engine and is audited", async () => {
    const running = live();
    const client = await connectClient(running.agent("search-only"), open);
    const result = await call(client, "world_view", { operation: "find_concepts" });
    expect(result.isError).toBe(true);
    expect(errorOf(result).error).toBe("tool_not_granted");
    const rows = listAudit(running.db, "search-only", { limit: 5 }).filter((row) => row.tool === "world_view");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.denied).toEqual([{ id: "tool:world_view", reason: "tool_not_granted" }]);
  });

  test("the input schema takes exactly the fields it lists", () => {
    expect(WORLD_VIEW_INPUT.safeParse({ operation: "find_concepts" }).success).toBe(true);
    expect(WORLD_VIEW_INPUT.safeParse({ operation: "find_concepts", extra: 1 }).success).toBe(false);
    expect(WORLD_VIEW_INPUT.safeParse({ operation: "everything" }).success).toBe(false);
    expect(WORLD_VIEW_INPUT.safeParse({ operation: "find_concepts", label: "x".repeat(201) }).success).toBe(false);
  });
});

describe("the advertised size", () => {
  test("tools/list stays under 40 KB", async () => {
    const client = await connectClient(live().owner(), open);
    const listed = await client.listTools();
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThan(40 * 1024);
    const world = listed.tools.find((tool) => tool.name === "world_view");
    expect(Buffer.byteLength(JSON.stringify(world?.outputSchema))).toBeLessThan(4 * 1024);
  });

  test("every world_view answer is held to the whole grammar, which the listing only summarizes", async () => {
    const running = live();
    await worldFixture(running.db);
    await worldFixture(running.db, { kind: "situation", subject: "project:launch", label: "Launch" });
    const client = await connectClient(running.owner(), open);
    const listed = z.strictObject(WORLD_ENVELOPE_LISTED);

    for (const kind of ["concept", "situation"] as const) {
      const found = envelopeOf(await call(client, "world_view", { operation: `find_${kind}s` }));
      const ref = (found["data"] as { result: { data: { matches: { ref: unknown }[] } } }).result.data.matches[0]!.ref;
      const card = envelopeOf(await call(client, "world_view", { operation: kind, [kind]: ref }));
      for (const envelope of [found, card]) {
        expect(WORLD_ENVELOPE.safeParse(envelope).success).toBe(true);
        expect(listed.safeParse(envelope).success).toBe(true);
      }
      // The summary lets through what only the whole grammar rejects.
      const damaged = structuredClone(card) as { data: { result: { data: Record<string, unknown> } } };
      damaged.data.result.data["unlisted"] = true;
      expect(listed.safeParse(damaged).success).toBe(true);
      expect(WORLD_ENVELOPE.safeParse(damaged).success).toBe(false);
    }
  });
});

describe("tools/list is scoped to the grant", () => {
  test("the owner is offered every tool", async () => {
    const client = await connectClient(live().owner(), open);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([...TOOLS]);
  });

  test("an agent is offered exactly the tools its grant allows", async () => {
    const running = live();
    const only = await connectClient(running.agent("search-only"), open);
    expect((await only.listTools()).tools.map((tool) => tool.name)).toEqual(["search"]);
    const plain = await connectClient(running.agent("plain"), open);
    // A default enrollment is granted no tool at all, so it is offered none.
    expect((await plain.listTools()).tools).toEqual([]);
  });

  test("a grant changed mid-session changes the next listing, and revocation empties it", async () => {
    const running = live();
    const client = await connectClient(running.agent("reader-personal"), open);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([...TOOLS]);
    setGrant(running.db, "reader-personal", { tools: ["search", "timeline"] });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["search", "timeline"]);
    revokeAgent(running.db, "reader-personal");
    expect((await client.listTools()).tools).toEqual([]);
  });

  test("a tool left out of the listing is still refused by the engine, not by the SDK", async () => {
    const running = live();
    const client = await connectClient(running.agent("search-only"), open);
    const result = await call(client, "timeline", { day: "2026-02-28" });
    expect(errorOf(result).error).toBe("tool_not_granted");
  });
});
