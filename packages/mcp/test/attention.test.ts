import { expect, test } from "bun:test";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../core/src/agents";
import { attentionFixture, ATTENTION_WHEN } from "../../core/test/helpers/attention-fixture";
import { startLoopback } from "../../core/test/helpers/world-kit/loopback";
import { call, connectClient, envelopeOf } from "./client";
test("listed MCP and authenticated HTTP expose matching read-only attention", async () => {
  const f = await attentionFixture(), close: (() => Promise<void>)[] = [], http = await startLoopback(f.db, f.vault.path);
  try {
    const client = await connectClient(f.ctx, close), listed = await client.listTools();
    expect(listed.tools.some(tool => /attention|dismiss|snooze/.test(tool.name))).toBe(false);
    const input = { operation: "attention", ...ATTENTION_WHEN }, mcp = await call(client, "world_view", input), response = await http.post("world_view", input);
    expect(mcp.isError ?? false).toBe(false); expect(response.status).toBe(200);
    expect((envelopeOf(mcp).data as any).result.data).toEqual(f.read());
    expect((response.body as any).value.data.result.data).toEqual(f.read());
    const agent = addAgent(f.db, "attention-mcp-reader", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["situation:attention"] });
    const ctx = { ...f.ctx, principal: authenticate(f.db, agent.token)! }, scoped = await connectClient(ctx, close);
    const agentRead = await call(scoped, "world_view", input), agentHttp = await http.post("world_view", input, agent.token);
    expect((envelopeOf(agentRead).data as any).result.data).toEqual((agentHttp.body as any).value.data.result.data);
    expect((await call(scoped, "world_view", { ...input, action: "dismiss" })).isError).toBe(true);
    expect((await http.post("attention_disposition", { cue: f.candidates()[0]!.cue, action: "dismiss" }, agent.token)).status).toBe(404);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM world_attention_state").get()!.n).toBe(0);
  } finally { for (const stop of close.reverse()) await stop(); await http.stop(); f.dispose(); }
}, 120_000);
