import { expect, test } from "bun:test";
import { skillFixture, PROCEDURE, WHEN } from "../../core/test/helpers/skill-fixture";
import { startLoopback } from "../../core/test/helpers/world-kit/loopback";
import { call, connectClient, envelopeOf } from "./client";
test("MCP and real HTTP expose read-only knowledge with unchanged tool count", async () => {
  const f = await skillFixture(), close: (() => Promise<void>)[] = [], http = await startLoopback(f.db, f.ctx.vaultPath);
  try {
    await f.file(0, "outcome.self_report");
    const client = await connectClient(f.ctx, close), listed = await client.listTools();
    expect(listed.tools).toHaveLength(10);
    expect(listed.tools.map(tool => tool.name)).not.toContain("report_outcome");
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThan(40 * 1024);
    for (const input of [
      { operation: "procedure", procedure: f.procedureRef, ...WHEN }, { operation: "skill", skill: f.skillRef, ...WHEN },
      { operation: "framework", framework: f.frameworkRef, ...WHEN }, { operation: "find_procedures", about: f.find(), ...WHEN },
      { operation: "find_skills", label: "skill:inspection", ...WHEN },
      { operation: "find_frameworks", label: "framework:quality", ...WHEN },
      { operation: "outcome", subject: PROCEDURE, ...WHEN },
    ]) {
      const mcp = await call(client, "world_view", input);
      expect(mcp.isError ?? false, JSON.stringify(mcp)).toBe(false);
      const response = await http.post("world_view", input);
      expect(response.status).toBe(200);
      expect((response.body as any).value.data.result.data).toEqual((envelopeOf(mcp).data as any).result.data);
    }
    for (const operation of ["find_skills", "find_frameworks"]) {
      for (const own of [{ label: "x".repeat(201) }, { cursor: "bad" }, { about: f.find() }, { unknown: true }])
        expect((await call(client, "world_view", { operation, ...own, ...WHEN })).isError).toBe(true);
    }
    const shared = envelopeOf(await call(client, "world_view", { operation: "share", of: { operation: "procedure", procedure: f.procedureRef }, ...WHEN })).data as any;
    const resumed = envelopeOf(await call(client, "world_view", { operation: "resume", handle: shared.result.data.handle, ...WHEN })).data as any;
    expect(resumed.result.data).toEqual(f.readProcedure());
    const agent = await connectClient(f.agents[0]!.ctx, close);
    const filed = await f.file(0, "outcome.provider_ack", { result: "acknowledged" });
    const timeline = envelopeOf(await call(agent, "timeline", { since: filed.event.occurred_at }));
    const evidence = (timeline.quoted as import("../../core/src/contracts/scoped-tools").QuotedChunkV2[])
      .find(chunk => chunk.text === filed.event.text)!;
    expect(evidence).toBeDefined();
    expect(evidence.subjects).toHaveLength(1);
    const replay = await call(agent, "propose", { ...filed.input, subject: f.findProcedure(f.agents[0]!.ctx), subjects: evidence.subjects,
      object: { kind: "literal", value: filed.input.object }, provenance: [evidence.eventVersion] });
    expect(replay.isError ?? false).toBe(false);
    expect((envelopeOf(replay).data as any).outcome).toBe("duplicate");
  } finally { for (const stop of close.reverse()) await stop(); await http.stop(); f.dispose(); }
}, 120_000);
