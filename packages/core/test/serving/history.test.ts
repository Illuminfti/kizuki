import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serveTimeline } from "../../src/serving/timeline";
import { ServeError } from "../../src/serving/types";
import { storeEvent, serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture;

beforeAll(async () => {
  fixture = await serveFixture();
  storeEvent(fixture.db, "history-later", "2026-02-28T20:00:00Z", "later authorized history text", "person:ada", "public");
});

afterAll(() => fixture?.dispose());

function tree(args: Parameters<typeof serveTimeline>[1]) {
  const data = serveTimeline(fixture.owner(), { view: "tree", ...args }).data;
  if (data === undefined || !("view" in data) || data.view !== "tree") throw new Error("expected history tree");
  return data;
}

function refusal(run: () => unknown): ServeError {
  try { run(); } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected refusal");
}

describe("optional extractive history tree", () => {
  test("is bounded, deterministic, and reaches an original only through existing expansion", () => {
    const first = tree({ day: "2026-02-28", budget_bytes: 128 });
    const second = tree({ day: "2026-02-28", budget_bytes: 128 });
    expect(first).toEqual(second);
    expect(new TextEncoder().encode(first.node.text).byteLength).toBeLessThanOrEqual(128);
    expect(first.coverage).toContain("first 200 authorized");
    expect(first.node.tainted).toBe(true);
    let current = first;
    while (current.node.children !== undefined) {
      current = tree({ day: "2026-02-28", snapshot: current.snapshot, node: current.node.children[0]!.node, budget_bytes: 128 });
    }
    expect(current.node.event_id).toBeDefined();
    const original = serveTimeline(fixture.owner(), { event_id: current.node.event_id!, offset: 0, span: 1 });
    expect(original.quoted).toHaveLength(1);
    expect(original.data).toHaveProperty("integrity");
  });

  test("zooms only when current filters, source state, principal and snapshot agree", () => {
    const root = tree({ day: "2026-02-28" });
    const child = root.node.children?.[0];
    expect(child).toBeDefined();
    const zoom = tree({ day: "2026-02-28", snapshot: root.snapshot, node: child!.node });
    expect(zoom.node.node).toBe(child!.node);
    expect(refusal(() => tree({ snapshot: root.snapshot, node: child!.node })).code).toBe("invalid_arguments");
    expect(refusal(() => tree({ day: "2026-02-28", snapshot: "a".repeat(64), node: child!.node })).code).toBe("invalid_arguments");
  });

  test("keeps the default timeline list contract unchanged", () => {
    const listed = serveTimeline(fixture.owner(), { day: "2026-02-28" });
    expect(listed.quoted.length).toBeGreaterThan(0);
    expect(listed.data).toBeUndefined();
  });

  test("does not expose capture through a history response but audits authorized evidence", () => {
    const response = serveTimeline(fixture.owner(), { view: "tree", day: "2026-02-28" });
    expect(response.quoted).toEqual([]);
    const audit = fixture.db.query<{ served: string; served_count: number }, []>("SELECT served, served_count FROM agent_audit WHERE tool='timeline' ORDER BY rowid DESC LIMIT 1").get();
    expect(audit?.served_count).toBeGreaterThan(0);
    expect(audit?.served).not.toContain("public kettle");
  });
});
