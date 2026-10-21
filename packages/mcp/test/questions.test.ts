import { expect, test } from "bun:test";
import { questionFixture, QUESTION_WHEN as WHEN } from "../../core/test/helpers/question-fixture";
import { startLoopback } from "../../core/test/helpers/world-kit/loopback";
import { call, connectClient, envelopeOf } from "./client";

test("listed MCP and real HTTP consumers agree on Questions, evidence and frontier", async () => {
  const f = await questionFixture(), close: (() => Promise<void>)[] = [];
  const http = await startLoopback(f.db, f.ctx.vaultPath);
  try {
    const client = await connectClient(f.ctx, close);
    const listed = await client.listTools();
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThan(40 * 1024);
    const inputs = [
      { operation: "find_questions", about: f.find(), ...WHEN },
      { operation: "question", question: f.questionRef, ...WHEN },
      { operation: "frontier", about: f.find(), ...WHEN },
    ];
    for (const input of inputs) {
      const mcp = await call(client, "world_view", input);
      expect(mcp.isError ?? false).toBe(false);
      const response = await http.post("world_view", input);
      expect(response.status).toBe(200);
      const mcpData = envelopeOf(mcp).data as { result: { data: unknown } };
      const httpData = response.body as { value: { data: { result: { data: unknown } } } };
      expect(httpData.value.data.result.data).toEqual(mcpData.result.data);
    }
    const card = f.readQuestion();
    const evidence = card.texts[0]!.assessments[0]!.evidence[0]!;
    const expanded = await call(client, "world_view", { operation: "evidence", evidence, ...WHEN });
    expect(expanded.isError ?? false).toBe(false);
    expect(envelopeOf(expanded).quoted).toHaveLength(1);
    const shared = envelopeOf(await call(client, "world_view", { operation: "share", of: { operation: "question", question: f.questionRef }, ...WHEN })).data as { result: { data: { handle: string } } };
    const resumed = envelopeOf(await call(client, "world_view", { operation: "resume", handle: shared.result.data.handle, ...WHEN })).data as { result: { data: unknown } };
    expect(resumed.result.data).toEqual(f.readQuestion());
    expect((await call(client, "world_view", { operation: "question", question: { kind: "object", token: "bad" } })).isError).toBe(true);
  } finally { for (const stop of close.reverse()) await stop(); await http.stop(); f.dispose(); }
}, 120_000);
