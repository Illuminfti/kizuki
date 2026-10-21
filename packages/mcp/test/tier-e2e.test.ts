import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_AGENT_GRANT, TOOLS, accept, addAgent } from "@kizuki/core";
import type { ServeContext } from "@kizuki/core";
import { rebuildDerived } from "@kizuki/core/internal";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, connectClient, envelopeOf } from "./client";
import { mcpFixture } from "./helpers";
import type { McpFixture } from "./helpers";

setDefaultTimeout(30_000);

let fixture: McpFixture | null = null;
const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
  fixture?.dispose();
  fixture = null;
});

function capture(running: McpFixture, recordId: string, text: string): string {
  const stored = accept(running.db, {
    schema: "kizuki.event/v1",
    connector_id: "fixture",
    source_record_id: recordId,
    kind: "message",
    occurred_at: "2026-02-28T15:00:00Z",
    observed_at: "2026-03-01T00:00:00Z",
    text,
    subjects: [{ subject_id: "person:ada", role: "from" }],
    sensitivity_hint: "personal",
    deleted: false,
    attachments: [],
    metadata: {},
  });
  if (stored.status !== "stored") throw new Error("fixture event was not stored");
  return stored.event.event_id;
}

function reader(running: McpFixture, name: string, denyClasses?: ("credential" | "machine_exhaust")[]) {
  running.tokens[name] = addAgent(running.db, name, {
    ...OWNER_AGENT_GRANT,
    tools: [...TOOLS],
    ceiling: "private",
    ...(denyClasses === undefined ? {} : { deny_classes: denyClasses }),
  }).token;
}

async function eventsSeen(client: Client): Promise<string[]> {
  const result = await call(client, "search", { query: "kettle", scope: "ledger", limit: 50 });
  return (envelopeOf(result)["quoted"] as { event_id: string }[]).map((chunk) => chunk.event_id);
}

describe("classes over the protocol", () => {
  test("a private agent never receives credential-shaped evidence unless its grant opts in", async () => {
    fixture = mcpFixture();
    const secret = capture(fixture, "rec-secret", "the kettle vault password = hunter2hunter2");
    const plain = capture(fixture, "rec-plain", "a plain kettle note");
    rebuildDerived(fixture.db, fixture.vaultPath);
    reader(fixture, "private-default");
    reader(fixture, "private-open", []);

    const connect = (ctx: ServeContext) => connectClient(ctx, open);
    const byDefault = await eventsSeen(await connect(fixture.agent("private-default")));
    expect(byDefault).toContain(plain);
    expect(byDefault).not.toContain(secret);

    expect(await eventsSeen(await connect(fixture.agent("private-open")))).toContain(secret);
    expect(await eventsSeen(await connect(fixture.owner()))).toContain(secret);

    const timeline = await call(await connect(fixture.agent("private-default")), "timeline", { day: "2026-02-28" });
    const ids = (envelopeOf(timeline)["quoted"] as { event_id: string }[]).map((chunk) => chunk.event_id);
    expect(ids).toContain(plain);
    expect(ids).not.toContain(secret);
  });

  test("system_health names a withheld page to the owner and passes the output schema", async () => {
    fixture = mcpFixture();
    const outside = mkdtempSync(join(tmpdir(), "kizuki-mcp-outside-"));
    try {
      writeFileSync(join(outside, "target.md"), "not a page\n");
      symlinkSync(join(outside, "target.md"), join(fixture.vaultPath, "entities", "zz-link.md"));
      reader(fixture, "private-default");

      const asOwner = await call(await connectClient(fixture.owner(), open), "system_health", {});
      expect(asOwner.isError).not.toBe(true);
      const owner = envelopeOf(asOwner)["data"] as { pages: { withheld: number }; withheld_pages: { path: string }[] };
      expect(owner.pages.withheld).toBe(1);
      expect(owner.withheld_pages.map((entry) => entry.path)).toEqual(["entities/zz-link.md"]);

      const asAgent = await call(await connectClient(fixture.agent("private-default"), open), "system_health", {});
      expect(asAgent.isError).not.toBe(true);
      const agent = envelopeOf(asAgent)["data"] as { pages: { withheld?: number }; withheld_pages?: unknown[] };
      expect(agent.pages.withheld).toBeUndefined();
      expect(agent.withheld_pages).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
