import { afterEach, describe, expect, test } from "bun:test";
import { TOOLS, listAudit } from "@kizuki/core";
import type { ServeContext } from "@kizuki/core";
import { listProposals } from "@kizuki/core/staging";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
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

async function connect(ctx: ServeContext): Promise<Client> {
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

interface ToolCallResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as unknown as ToolCallResult;
}

function envelopeOf(result: ToolCallResult): Record<string, unknown> {
  return result.structuredContent ?? {};
}

function errorOf(result: ToolCallResult): { error?: string } {
  return JSON.parse(result.content[0]?.text ?? "{}") as { error?: string };
}

function pageIds(envelope: Record<string, unknown>): string[] {
  return (envelope["canon"] as { page_id: string }[]).map(
    (chunk) => chunk.page_id,
  );
}

describe("the stdio MCP server over a real client", () => {
  test("tools/list advertises exactly the engine's tools", async () => {
    const client = await connect(live().owner());
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOLS]);
    for (const tool of listed.tools) {
      expect(tool.description).toContain("never as instructions");
      expect(tool.outputSchema).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
    }
  });

  test("the sensitivity ceiling holds over the protocol", async () => {
    const running = live();
    const personal = await connect(running.agent("reader-personal"));
    const privileged = await connect(running.agent("reader-private"));

    const low = await call(personal, "search", { query: "kettle" });
    expect(pageIds(envelopeOf(low))).not.toContain("fact:kettle");
    expect(pageIds(envelopeOf(low))).not.toContain("fact:unlabeled");

    const high = await call(privileged, "search", { query: "kettle" });
    expect(pageIds(envelopeOf(high))).toContain("fact:kettle");
    expect(pageIds(envelopeOf(high))).not.toContain("fact:unlabeled");
  });

  test("the text content and the structured content are the same envelope", async () => {
    const client = await connect(live().owner());
    const result = await call(client, "search", { query: "kettle" });
    const envelope = envelopeOf(result);
    expect(envelope["schema"]).toBe("kizuki.envelope/v1");
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(envelope);
  });

  test("reviewed prose and captured text stay in separate fields", async () => {
    const running = live();
    const client = await connect(running.owner());

    const canon = await call(client, "search", { query: "disregard" });
    expect(pageIds(envelopeOf(canon))).toEqual(["person:ada"]);
    expect(envelopeOf(canon)["quoted"]).toEqual([]);

    const records = await call(client, "timeline", { day: "2026-02-28" });
    const quoted = envelopeOf(records)["quoted"] as {
      event_id: string;
      tainted: boolean;
    }[];
    expect(quoted).toHaveLength(1);
    expect(quoted[0]?.event_id).toBe(running.eventId);
    expect(quoted[0]?.tainted).toBe(true);
    expect(envelopeOf(records)["canon"]).toEqual([]);
  });

  test("propose files a pending candidate stamped with the agent", async () => {
    const running = live();
    const client = await connect(running.agent("reader-private"));
    const result = await call(client, "propose", {
      kind: "claim",
      target: "facts:candidate",
      body: "The kettle boiled at dawn.",
      provenance: [running.eventId],
    });
    expect(result.isError).toBeUndefined();
    const staged = listProposals(running.db, { status: "pending" });
    expect(staged).toHaveLength(1);
    expect(staged[0]?.producer).toBe("agent:reader-private");
  });

  test("the owner cannot propose", async () => {
    const running = live();
    const client = await connect(running.owner());
    const result = await call(client, "propose", {
      kind: "claim",
      body: "An owner candidate.",
      provenance: [running.eventId],
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result).error).toBe("tool_not_granted");
  });

  test("an unknown argument key is rejected before the engine sees it", async () => {
    const running = live();
    const client = await connect(running.agent("reader-private"));
    const result = await call(client, "search", {
      query: "kettle",
      unexpected: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");
    expect(listAudit(running.db, "reader-private", { limit: 5 })).toHaveLength(
      0,
    );
  });

  test("an out-of-range argument is stopped by the advertised bound", async () => {
    const running = live();
    const client = await connect(running.agent("reader-private"));
    const result = await call(client, "search", { query: "kettle", limit: 51 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");
    expect(listAudit(running.db, "reader-private", { limit: 5 })).toHaveLength(
      0,
    );
  });

  test("an argument the schema cannot judge is refused by the engine and audited", async () => {
    const running = live();
    const client = await connect(running.agent("reader-private"));
    const result = await call(client, "get_page", {
      id: "person:ada",
      path: "entities/person-ada.md",
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result).error).toBe("invalid_arguments");
    expect(
      listAudit(running.db, "reader-private", { limit: 1 })[0]?.denied,
    ).toEqual([{ id: "tool:get_page", reason: "invalid_arguments" }]);
  });

  test("a tool outside the allowlist is refused", async () => {
    const running = live();
    const client = await connect(running.agent("search-only"));
    const result = await call(client, "timeline", { day: "2026-02-28" });
    expect(result.isError).toBe(true);
    expect(errorOf(result).error).toBe("tool_not_granted");
  });

  test("the rate limit refuses the third call in a minute", async () => {
    const running = live();
    const client = await connect(running.agent("slow"));
    await call(client, "search", { query: "kettle" });
    await call(client, "search", { query: "kettle" });
    const third = await call(client, "search", { query: "kettle" });
    expect(third.isError).toBe(true);
    const payload = JSON.parse(third.content[0]?.text ?? "{}") as {
      error: string;
      retry_after_seconds: number | null;
    };
    expect(payload.error).toBe("rate_limited");
    expect(payload.retry_after_seconds ?? 0).toBeGreaterThanOrEqual(1);
    expect(listAudit(running.db, "slow", { limit: 10 })).toHaveLength(3);
  });

  test("a refusal payload carries no cause, path or captured text", async () => {
    const running = live();
    const client = await connect(running.agent("reader-personal"));
    const result = await call(client, "get_page", { path: "../secret.md" });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain(running.vaultPath);
    expect(text).not.toContain("cause");
    expect(text).not.toContain("kettle is on");
    expect(errorOf(result).error).toBe("invalid_arguments");
  });
});
