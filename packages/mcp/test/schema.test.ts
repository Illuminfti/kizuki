import { afterEach, describe, expect, test } from "bun:test";
import {
  ENVELOPE_SCHEMA,
  TOOLS,
  registerConnection,
  setSourceGrant,
  sourcePolicyEpoch,
  ulid,
} from "@kizuki/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ENVELOPE_SHAPE } from "../src/schemas";
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

  test("epoch-zero responses omit source_policy and still satisfy a listed client", async () => {
    const running = live();
    expect(sourcePolicyEpoch(running.db)).toBe(0);
    const result = await call(await listed(running), "get_page", {
      id: "person:ada",
    });
    expect(result.isError ?? false).toBe(false);
    const structured = envelopeOf(result);
    const text = JSON.parse(result.content[0]?.text ?? "{}") as Record<
      string,
      unknown
    >;
    expect(structured).not.toHaveProperty("source_policy");
    expect(text).not.toHaveProperty("source_policy");
    expect(text).toEqual(structured);
  });

  test("a listed client accepts an ordinary source-policy envelope on both channels", async () => {
    const running = live();
    const source_key = ulid();
    registerConnection(running.db, "kizuki.fixture", source_key);
    setSourceGrant(running.db, {
      source_key,
      expected_revision: 0,
      operation_id: "schema-source-policy",
      policy: {
        purposes: ["capture"],
        allowed_fields: ["text"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        sensitivity_floor: "private",
      },
    });
    const epoch = sourcePolicyEpoch(running.db);
    expect(epoch).toBeGreaterThan(0);
    const policy = {
      mode: "enforced" as const,
      epoch,
      legacy_unbound: "owner_only" as const,
    };

    const result = await call(await listed(running), "get_page", {
      id: "person:ada",
    });
    expect(result.isError ?? false).toBe(false);
    const structured = envelopeOf(result);
    const text = JSON.parse(result.content[0]?.text ?? "{}") as Record<
      string,
      unknown
    >;
    expect(structured["source_policy"]).toEqual(policy);
    expect(text["source_policy"]).toEqual(policy);
    expect(text).toEqual(structured);
  });

  test("every tool advertises optional source_policy with the exact three members", async () => {
    const client = await connectClient(live().owner(), open);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual([...TOOLS]);
    for (const tool of tools) {
      const advertised = tool.outputSchema as {
        required?: string[];
        properties?: { source_policy?: { required?: string[] } };
      };
      expect(advertised.required?.slice().sort()).toEqual(
        ["at", "canon", "denied", "principal", "quoted", "schema", "tool"],
      );
      expect(advertised.properties?.source_policy?.required?.slice().sort()).toEqual(
        ["epoch", "legacy_unbound", "mode"],
      );
    }
  });

  test("the source_policy object rejects missing, extra, mistyped and invalid members", () => {
    const envelope = {
      schema: ENVELOPE_SCHEMA,
      tool: "search" as const,
      principal: "owner",
      at: "2026-02-28T10:00:00.000Z",
      canon: [],
      quoted: [],
      denied: [],
    };
    const policy = {
      mode: "enforced" as const,
      epoch: 1,
      legacy_unbound: "owner_only" as const,
    };
    expect(ENVELOPE_SHAPE.safeParse(envelope).success).toBe(true);
    expect(
      ENVELOPE_SHAPE.safeParse({ ...envelope, source_policy: policy }).success,
    ).toBe(true);
    expect(ENVELOPE_SHAPE.safeParse({ ...envelope, tool: undefined }).success).toBe(
      false,
    );

    const invalid = [
      {},
      { mode: "enforced", epoch: 1 },
      { mode: "enforced", legacy_unbound: "owner_only" },
      { epoch: 1, legacy_unbound: "owner_only" },
      { ...policy, extra: true },
      { ...policy, mode: "advisory" },
      { ...policy, epoch: 0 },
      { ...policy, epoch: -1 },
      { ...policy, epoch: 1.5 },
      { ...policy, epoch: "1" },
      { ...policy, mode: true },
      { ...policy, legacy_unbound: "anyone" },
      { ...policy, legacy_unbound: 1 },
      null,
      "enforced",
    ];
    for (const source_policy of invalid) {
      expect(
        ENVELOPE_SHAPE.safeParse({ ...envelope, source_policy }).success,
      ).toBe(false);
    }
  });
});
