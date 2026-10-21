import { afterEach, expect, test } from "bun:test";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { ConnectionStateStore } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createServeRuntime } from "../../src/serve-runtime";
import { startFakeEndpoint } from "../../../llm/test/fake-endpoint";
import { createHelpers } from "../helpers";
import { worldSeed } from "../../../core/test/helpers/world-seed";
import { inspectSourceGrant, setSourceGrant, sourceEventsAllowed } from "../../../core/src/ledger/source-grants";
import { writeRailCursor } from "../../../core/src/ledger/checkpoints";
import { getRunReceipt } from "../../../core/src/serve/receipts";
import { runRail } from "../../../core/src/serve/rails";
import { readWorldView } from "../../../core/src/serving/world-view";

const { cleanup, tempVault } = createHelpers();
afterEach(cleanup);
test("native runtime forwards its exact consent-bound model to the scheduled consolidation job", async () => {
  const setup = tempVault(), db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  const text = "Model consolidation through the configured runtime.";
  const endpoint = startFakeEndpoint((request) => {
    const body = request.body as { messages: { role: string; content: string }[] };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]!.content).toContain("kizuki.consolidation-response/v1");
    expect(body.messages[1]!.content).toContain("KZ-QUOTE");
    return Response.json({ id: "synthetic-summary", object: "chat.completion", created: 1, model: "fixture",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ schema: "kizuki.consolidation-response/v1", status: "complete", summary: text }) } }],
      usage: { prompt_tokens: 40, completion_tokens: 16 } });
  });
  let runtime: Awaited<ReturnType<typeof createServeRuntime>> | undefined;
  try {
    const seed = await worldSeed(db), grant = inspectSourceGrant(db, seed.sourceKey)!;
    setSourceGrant(db, { source_key: seed.sourceKey, expected_revision: grant.revision, operation_id: "runtime-summary-grant",
      policy: { ...grant.policy, purposes: [...grant.policy.purposes, "extract"], egress: {
        model_endpoint: `${endpoint.base_url}/chat/completions`, model: "fixture", external_retention: "provider_managed" } } });
    const accepted = db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id=?").get(seed.eventId)!;
    writeRailCursor(db, "kizuki.producer.model", "extract", `${accepted.accepted_at}\t${seed.eventId}`);
    const path = join(setup.vault, ".kizuki/serve.toml");
    writeFileSync(path, `[ports.llm]\nid="kizuki.llm.openai-compatible"\nbase_url=${JSON.stringify(endpoint.base_url)}\nmodel="fixture"\ntimeout_ms=1000\nmax_retries=0\n[consolidation]\nmax_calls_per_pass=1\nmax_handles_per_pass=1\n`, { mode: 0o600 }); chmodSync(path, 0o600);
    runtime = await createServeRuntime({ db, vaultPath: setup.vault, store: new ConnectionStateStore(join(setup.vault, ".kizuki")), env: setup.env, err: () => {} });
    expect(runtime.hooks.llm).toBeDefined();
    expect(sourceEventsAllowed(db, [seed.eventId], { owner: true, model: true, purpose: "extract", port: runtime.hooks.llm! })).toBe(true);
    const { sync: _sync, refresh: _refresh, ...hooks } = runtime.hooks;
    const receipt = await runRail(db, setup.vault, "sync", { hooks });
    expect(receipt.errors).toEqual([]); expect(endpoint.requests).toHaveLength(1);
    expect(receipt.consolidation).toMatchObject({ calls: 1, completed: 1, input_tokens: 40, output_tokens: 16, output_tokens_charged: 1024, usage_unknown: false, outcomes: { complete: 1 } });
    expect(getRunReceipt(db, receipt.run_id)?.consolidation).toEqual(receipt.consolidation);
    const view = readWorldView({ ...seed.ctx, vaultPath: setup.vault }, { operation: "concept", concept: seed.ref,
      valid: { kind: "all" }, knownAt: { kind: "current" } });
    if (!("result" in view) || view.result.status === "unavailable" || view.result.data.schema !== "kizuki.concept-card/v1") throw new Error("runtime Concept unavailable");
    expect(view.result.data.summary?.text).toBe(text); expect(view.result.data.summary?.admissions.length).toBeGreaterThan(0);
  } finally { await runtime?.close(); endpoint.stop(); db.close(); }
});
