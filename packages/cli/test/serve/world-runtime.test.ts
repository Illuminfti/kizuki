import { afterEach, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectionStateStore, PRODUCER_V2_CONTRACT, type ProducerV2Port } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createServeRuntime } from "../../src/serve-runtime";
import { startFakeEndpoint } from "../../../llm/test/fake-endpoint";
import { createHelpers } from "../helpers";

const { cleanup, tempVault } = createHelpers();
afterEach(cleanup);

test("production composition explicitly binds typed extraction and retains model-free off mode", async () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  const endpoint = startFakeEndpoint(request => {
    const body = request.body as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toContain("kizuki.producer-response/v2");
    return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "fixture",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ schema: "kizuki.producer-response/v2", mentions: [], claims: [] }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  const config = join(setup.vault, ".kizuki/serve.toml");
  const writeConfig = (text: string) => { writeFileSync(config, text, { mode: 0o600 }); chmodSync(config, 0o600); };
  const options = { db, vaultPath: setup.vault, store: new ConnectionStateStore(join(setup.vault, ".kizuki")), env: setup.env, err: () => {} };
  try {
    writeConfig(`[ports.llm]\nid="kizuki.llm.openai-compatible"\nbase_url=${JSON.stringify(endpoint.base_url)}\nmodel="fixture"\ntimeout_ms=1000\nmax_retries=0\n`);
    const runtime = await createServeRuntime(options);
    try {
      expect(runtime.hooks.producer?.descriptor.contract).toBe(PRODUCER_V2_CONTRACT);
      expect(runtime.hooks.model_ref).toBe("kizuki.llm.openai-compatible:fixture@127.0.0.1");
      const producer = runtime.hooks.producer as ProducerV2Port;
      expect(await producer.produce({ events: [{ event_id: "00000000000000000000000001", text: "Synthetic source." }], supplied_refs: [], predicates: [], vocabulary_refs: [], budget: { max_calls: 1, max_input_tokens: 8000, max_output_tokens: 1000 } })).toMatchObject({ status: "ok", response: { claims: [] } });
      expect(endpoint.requests).toHaveLength(1);
    } finally { await runtime.close(); }
    expect((await runtime.hooks.producer!.health()).status).toBe("unavailable");
    writeConfig('[ports]\nllm="kizuki.llm.none"\n');
    const off = await createServeRuntime(options);
    try { expect(off.hooks.producer).toBeUndefined(); expect(off.hooks.model_ref).toBeNull(); }
    finally { await off.close(); }
    expect(endpoint.requests).toHaveLength(1);
  } finally { endpoint.stop(); db.close(); }
});
