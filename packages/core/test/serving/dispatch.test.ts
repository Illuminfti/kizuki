import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TOOLS } from "../../src/agents";
import type { Tool } from "../../src/agents";
import { ServeError, dispatchServeTool } from "../../src/serving";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture;

beforeAll(async () => {
  fixture = await serveFixture();
});

afterAll(() => {
  fixture.dispose();
});

describe("dispatchServeTool", () => {
  test("every registered tool is reachable through the one switch", async () => {
    const ctx = fixture.agent("reader-private");
    const publicEvent = fixture.events["public"];
    if (publicEvent === undefined) throw new Error("missing fixture event");
    const filed = await dispatchServeTool(ctx, "propose", {
      kind: "claim",
      body: "Ada is an engineer at the kettle works.",
      subject: "person:ada",
      predicate: "employment.role",
      object: "engineer",
      provenance: [publicEvent],
    });
    const claimId = (filed.data as { claim_id?: string } | undefined)?.claim_id;
    if (claimId === undefined) throw new Error("propose did not return a claim_id");
    const args: Record<Tool, Record<string, unknown>> = {
      search: { query: "kettle" },
      get_page: { id: "person:ada" },
      query_entities: { type: "person" },
      timeline: { day: "2026-02-28" },
      context_packet: { query: "ada" },
      graph_neighbors: { id: "person:ada" },
      system_health: {},
      world_view: {
        operation: "situation",
        situation: {
          kind: "object",
          token: Buffer.from(Uint8Array.from({ length: 32 }, () => 1)).toString("base64url"),
        },
        valid: { kind: "all" },
        knownAt: { kind: "current" },
      },
      propose: {
        kind: "claim",
        body: "dispatch fixture claim",
        provenance: [publicEvent],
      },
      correct: {
        statement: "the role is founder",
        target: { claim_id: claimId },
        dry_run: true,
      },
    };
    for (const tool of TOOLS) {
      const envelope = await dispatchServeTool(ctx, tool, args[tool]);
      expect(envelope.tool).toBe(tool);
      // world_view answers in its closed v2 envelope; every other tool keeps v1.
      expect(envelope.schema).toBe(tool === "world_view" ? "kizuki.envelope/v2" : "kizuki.envelope/v1");
    }
  });

  test("a bad argument is the engine's ServeError, not a host remap", async () => {
    await expect(
      dispatchServeTool(fixture.owner(), "search", { query: "" }),
    ).rejects.toMatchObject({
      name: "ServeError",
      code: "invalid_arguments",
    });
    await expect(
      dispatchServeTool(fixture.owner(), "search", { query: "" }),
    ).rejects.toBeInstanceOf(ServeError);
  });
});
