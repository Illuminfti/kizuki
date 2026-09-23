import { afterEach, expect, test } from "bun:test";
import { worldFixture } from "../../core/test/serving/world-fixture";
import { call, connectClient, envelopeOf } from "./client";
import { mcpFixture, type McpFixture } from "./helpers";

let fixture: McpFixture | null = null;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  fixture?.dispose();
  fixture = null;
});

test("listed MCP client discovers and reads real supported Concept and Situation cards", async () => {
  fixture = mcpFixture();
  await worldFixture(fixture.db);
  await worldFixture(fixture.db, {
    kind: "situation",
    subject: "project:launch",
    label: "Launch",
  });
  const client = await connectClient(fixture.owner(), open);
  for (const kind of ["concept", "situation"] as const) {
    const discovered = await call(client, "world_view", {
      operation: kind === "concept" ? "find_concepts" : "find_situations",
      label: "",
      valid: { kind: "all" },
      knownAt: { kind: "current" },
    });
    expect(discovered.isError ?? false).toBe(false);
    const envelope = envelopeOf(discovered);
    expect(envelope.schema).toBe("kizuki.envelope/v2");
    expect(envelope).not.toHaveProperty("source_policy");
    expect(envelope).not.toHaveProperty("denied");
    const payload = envelope.data as {
      result: {
        data: { matches: { ref: { kind: "object"; token: string } }[] };
      };
    };
    const ref = payload.result.data.matches[0]!.ref;
    const read = await call(client, "world_view", {
      operation: kind,
      [kind]: ref,
      valid: { kind: "all" },
      knownAt: { kind: "current" },
    });
    expect(read.isError ?? false).toBe(false);
    expect(JSON.stringify(envelopeOf(read))).toContain(
      "Revise beliefs using evidence",
    );
  }
  const malformed = await call(client, "world_view", {
    operation: "concept",
    concept: { kind: "object", token: "A".repeat(42) + "B" },
    valid: { kind: "all" },
    knownAt: { kind: "current" },
  });
  expect(malformed.isError).toBe(true);
});
