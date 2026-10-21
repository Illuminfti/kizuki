import { expect, test } from "bun:test";
import { artifactFixture, ART_WHEN } from "../../core/test/helpers/artifact-fixture";
import { startLoopback } from "../../core/test/helpers/world-kit/loopback";
import { call, connectClient, envelopeOf } from "./client";
test("MCP and real HTTP preserve artifact version bindings with unchanged tool count", async () => {
  const f = await artifactFixture(), close: (() => Promise<void>)[] = [], http = await startLoopback(f.db, f.ctx.vaultPath);
  try {
    const item = await f.capture("Captured exact artifact"), ref = item.ref();
    const client = await connectClient(f.ctx, close), listed = await client.listTools();
    expect(listed.tools).toHaveLength(10);
    expect(listed.tools.map(tool => tool.name)).not.toContain("report_outcome");
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThan(40 * 1024);
    for (const input of [
      { operation: "artifact_version", artifact: ref, ...ART_WHEN }, { operation: "find_artifacts", label: "", ...ART_WHEN },
    ]) {
      const mcp = await call(client, "world_view", input);
      expect(mcp.isError ?? false, JSON.stringify(mcp)).toBe(false);
      const response = await http.post("world_view", input);
      expect(response.status).toBe(200);
      expect((response.body as any).value.data.result.data).toEqual((envelopeOf(mcp).data as any).result.data);
    }
    const shared = envelopeOf(await call(client, "world_view", { operation: "share", of: { operation: "artifact_version", artifact: ref }, ...ART_WHEN })).data as any;
    const resumed = envelopeOf(await call(client, "world_view", { operation: "resume", handle: shared.result.data.handle, ...ART_WHEN })).data as any;
    expect(resumed.result.data).toEqual(item.card());
  }
  finally {
    for (const stop of close.reverse())
      await stop();
    await http.stop();
    f.dispose();
  }
}, 120000);
