import { expect, test } from "bun:test";
import { personFixture, ADA, PERSON_WHEN as WHEN } from "../../core/test/helpers/person-fixture";
import { startLoopback } from "../../core/test/helpers/world-kit/loopback";
import { call, connectClient, envelopeOf } from "./client";
test("listed MCP and real HTTP return the same Person and exact evidence, and resume preserves attribution", async () => {
  const f = await personFixture(), close: (() => Promise<void>)[] = [];
  const http = await startLoopback(f.db, f.ctx.vaultPath);
  try {
    await f.write("person.role", { kind: "literal", value: "Reviewer" }, { subject: ADA, holder: ADA, mode: "quoted" });
    const client = await connectClient(f.ctx, close), listed = await client.listTools();
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThan(40 * 1024);
    for (const input of [{ operation: "find_people", ...WHEN }, { operation: "person", person: f.personRef, ...WHEN }]) {
      const mcp = await call(client, "world_view", input), response = await http.post("world_view", input);
      expect(mcp.isError ?? false).toBe(false); expect(response.status).toBe(200);
      const body = response.body as { value: { data: { result: { data: unknown } } } };
      expect(body.value.data.result.data).toEqual((envelopeOf(mcp).data as { result: { data: unknown } }).result.data);
    }
    const evidence = f.readPerson().roles[0]!.assessments[0]!.evidence[0]!;
    const expanded = await call(client, "world_view", { operation: "evidence", evidence, ...WHEN });
    expect(expanded.isError ?? false).toBe(false); expect(envelopeOf(expanded).quoted).toHaveLength(1);
    const shared = envelopeOf(await call(client, "world_view", { operation: "share", of: { operation: "person", person: f.personRef }, ...WHEN })).data as { result: { data: { handle: string } } };
    const resumed = envelopeOf(await call(client, "world_view", { operation: "resume", handle: shared.result.data.handle, ...WHEN })).data as { result: { data: unknown } };
    expect(resumed.result.data).toEqual(f.readPerson());
  } finally { for (const stop of close.reverse()) await stop(); await http.stop(); f.dispose(); }
}, 120_000);
