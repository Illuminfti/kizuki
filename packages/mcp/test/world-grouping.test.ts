import { afterEach, expect, test } from "bun:test";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "@kizuki/core";
import { withWorldPipeline } from "@kizuki/core/testing";
import { readWorldView } from "@kizuki/core/world";
import { worldSeed } from "../../core/test/helpers/world-seed";
import { call, connectClient, envelopeOf } from "./client";
import { mcpFixture, type McpFixture } from "./helpers";

let fixture: McpFixture | null = null;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  fixture?.dispose();
  fixture = null;
});

for (const kind of ["concept", "situation"] as const) {
  for (const counts of [[85, 85, 86], [85, 85, 87], [101, 101, 101]]) {
    const total = counts.reduce((sum, count) => sum + count, 0);
    test(`Core and MCP grouped ${kind} discovery agree at ${total} labels`, async () => {
      fixture = mcpFixture();
      const db = fixture.db;
      // Compare full fresh projections without their independently issued tokens.
      // Reserved and conditional view behavior is covered by the VIEW tests.
      db.query("DELETE FROM world_view_partitions").run();
      for (const [index, count] of counts.entries()) {
        await worldSeed(db, {
          kind, subject: `topic:label-group-${index}`, label: `Group ${index}`,
          discover: false,
          predicates: Array.from({ length: count - 1 }, (_, label) => ({
            predicate: `${kind}.label`,
            object: { kind: "literal" as const, value: `Alias ${index}-${label}` },
          })),
        });
      }
      const ctx = fixture.owner();
      const client = await connectClient(ctx, open);
      const members = db.query<{ handle_id: string }, []>("SELECT handle_id FROM semantic_bindings ORDER BY handle_id")
        .all().map((row) => row.handle_id);
      const args = {
        operation: `find_${kind}s`, label: "",
        valid: { kind: "all" }, knownAt: { kind: "current" },
      };
      const refsBefore = db.query<{ count: number }, []>("SELECT count(*) AS count FROM world_wire_refs").get()!.count;
      await withWorldPipeline({ groupers: [(_frame, cluster) => ({ ...cluster, members, resolution: "resolved" })] }, async () => {
        const core = readWorldView(ctx, args);
        if (total > 256) {
          expect(core).toEqual({
            schema: "kizuki.world-view/v1", operation: args.operation,
            result: { status: "unavailable", reason: "budget" },
          });
          expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM world_wire_refs").get()!.count)
            .toBe(refsBefore);
        } else {
          expect(core).toMatchObject({ result: { status: "current" } });
          if (!("result" in core) || core.result.status === "unavailable" || !("matches" in core.result.data))
            throw new Error("grouped discovery unavailable");
          expect(core.result.data.matches).toHaveLength(1);
          expect(core.result.data.matches[0]!.labels).toHaveLength(total);
        }
        const served = await call(client, "world_view", args);
        expect(served.isError ?? false).toBe(false);
        expect(envelopeOf(served).data).toEqual(core);
        if (total === 303) {
          const agent = addAgent(db, "group-label-reader", {
            ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["topic:label-group-0"],
          });
          db.query("DELETE FROM world_view_partitions WHERE principal_id=?").run(agent.agent.agent_id);
          const narrow = { ...ctx, principal: authenticate(db, agent.token)! };
          const visible = readWorldView(narrow, args);
          expect(visible).toMatchObject({ result: { status: "current" } });
          if (!("result" in visible) || visible.result.status === "unavailable" || !("matches" in visible.result.data))
            throw new Error("scoped discovery unavailable");
          expect(visible.result.data.matches[0]!.labels).toHaveLength(101);
          const scopedClient = await connectClient(narrow, open);
          const scoped = await call(scopedClient, "world_view", args);
          expect(scoped.isError ?? false).toBe(false);
          expect(envelopeOf(scoped).data).toEqual(visible);
        }
      });
    }, 120_000);
  }
}
