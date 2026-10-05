import { afterEach, describe, expect, test } from "bun:test";
import { accept } from "@kizuki/core";
import { call, connectClient, envelopeOf, errorOf } from "./client";
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
  const stored = accept(fixture.db, {
    schema: "kizuki.event/v1",
    connector_id: "fixture",
    source_record_id: "rec-public-second",
    kind: "message",
    occurred_at: "2026-02-28T10:31:00Z",
    observed_at: "2026-03-01T00:00:00Z",
    text: "the second public kettle record",
    subjects: [{ subject_id: "person:ada", role: "from" }],
    sensitivity_hint: "public",
    deleted: false,
    attachments: [],
    metadata: {},
  });
  if (stored.status !== "stored") throw new Error("second history fixture event was not stored");
  return fixture;
}

async function client(running: McpFixture, identity = running.owner()) {
  return connectClient(identity, open);
}

type Tree = {
  view: "tree";
  snapshot: string;
  node: { node: string; event_id?: string; children?: { node: string }[]; tainted: true };
  budget_bytes: number;
};

function tree(result: Awaited<ReturnType<typeof call>>): Tree {
  const envelope = envelopeOf(result);
  expect(envelope["canon"]).toEqual([]);
  expect(envelope["quoted"]).toEqual([]);
  return envelope["data"] as Tree;
}

describe("optional timeline history tree over MCP", () => {
  test("advertises tree fields, zooms with the same filter, then opens the original event", async () => {
    const running = live();
    const owner = await client(running);
    const listed = await owner.listTools();
    const timeline = listed.tools.find((tool) => tool.name === "timeline");
    const properties = (timeline?.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(properties).toEqual(expect.objectContaining({ view: expect.anything(), budget_bytes: expect.anything(), snapshot: expect.anything(), node: expect.anything() }));

    let current = tree(await call(owner, "timeline", { view: "tree", connector_id: "fixture", budget_bytes: 128 }));
    expect(current.view).toBe("tree");
    expect(current.budget_bytes).toBe(128);
    while (current.node.children !== undefined) {
      const next = await call(owner, "timeline", {
        view: "tree",
        connector_id: "fixture",
        snapshot: current.snapshot,
        node: current.node.children[0]!.node,
        budget_bytes: 128,
      });
      expect(next.isError ?? false).toBe(false);
      current = tree(next);
    }
    expect(current.node.tainted).toBe(true);
    expect(current.node.event_id).toBeDefined();
    const original = await call(owner, "timeline", { event_id: current.node.event_id, offset: 0, span: 1 });
    expect(original.isError ?? false).toBe(false);
    expect((envelopeOf(original)["quoted"] as { event_id: string }[])[0]?.event_id).toBe(current.node.event_id);
  });

  test("denied and incompatible calls return generic errors without captured text", async () => {
    const running = live();
    const denied = await call(await client(running, running.agent("search-only")), "timeline", { view: "tree" });
    expect(denied.isError).toBe(true);
    expect(errorOf(denied).error).toBe("tool_not_granted");

    const invalid = await call(await client(running), "timeline", { view: "tree", limit: 1 });
    expect(invalid.isError).toBe(true);
    expect(errorOf(invalid).error).toBe("invalid_arguments");

    for (const result of [denied, invalid]) {
      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0]?.text).not.toContain("public kettle");
      expect(result.content[0]?.text).not.toContain("rec-public");
    }
  });
});
