import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConnectionStateStore, inspectSourceGrant, listClaims, listConnections, listRunReceipts,
  readServePid, runServeDaemon, setSourceGrant, sourcePolicyEpoch,
} from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createServeRuntime } from "../../src/serve-runtime";
import { startFakeEndpoint, type SeenRequest } from "../../../llm/test/fake-endpoint";
import { createHelpers } from "../helpers";

const { cleanup, tempVault, runCli } = createHelpers();
afterEach(cleanup);

function completion(request: SeenRequest, label: string): Response {
  const body = request.body as { model: string; messages: { content: string }[] };
  const prompt = body.messages[1]!.content;
  const eventId = /record ([A-Za-z0-9:_.-]+) from/.exec(prompt)?.[1];
  const subject = /"subject":"((?:\\.|[^"])*)"/.exec(prompt)?.[1];
  if (!eventId || !subject) throw new Error("synthetic extraction fixture mismatch");
  return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: body.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ claims: [{
      kind: "claim", subject: JSON.parse(`"${subject}"`), predicate: "employment.role", object: `${label} library collaborator`,
      polarity: "positive", body: `Ada coordinates the ${label} library group.`, valid_from: null, valid_to: null,
      confidence: 0.7, sensitivity: "personal", event_ids: [eventId],
    }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
}

test("scheduled attempts adopt settings without restart, pin credentials in flight, and recover after off and invalid settings", async () => {
  const setup = tempVault();
  const notes = join(setup.root, "adoption-notes"); mkdirSync(notes);
  const note = (phase: number) => writeFileSync(join(notes, `phase-${phase}.md`), `Ada joined the orchard library project, phase ${phase}.`);
  note(1);
  expect(runCli(setup.env, "connect", "markdown-folder", "--source", notes).exitCode).toBe(0);
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  const store = new ConnectionStateStore(join(setup.vault, ".kizuki"));
  const source = listConnections(db).find(row => row.connector_id === "kizuki.markdown-folder")!;
  const first = startFakeEndpoint(request => completion(request, "alpha"));
  const second = startFakeEndpoint(request => completion(request, "beta"));
  const secretPath = join(setup.vault, ".kizuki/model-fixture.key");
  const firstKey = "synthetic-key-alpha", secondKey = "synthetic-key-beta";
  writeFileSync(secretPath, firstKey, { mode: 0o600 });
  const configPath = join(setup.vault, ".kizuki/serve.toml");
  const configure = (baseUrl: string, model: string) => writeFileSync(configPath,
    `[ports.llm]\nid="kizuki.llm.openai-compatible"\nbase_url=${JSON.stringify(baseUrl)}\nmodel=${JSON.stringify(model)}\nsecret_ref=${JSON.stringify(`file:${secretPath}`)}\ntimeout_ms=1000\nmax_retries=0\n`);
  const grant = (baseUrl: string, model: string, revision: number) => setSourceGrant(db, {
    source_key: source.source_key, expected_revision: revision, operation_id: `fixture-runtime-grant-${revision}`,
    policy: { purposes: ["capture", "recall", "session", "derive", "extract", "export"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked",
      egress: { model_endpoint: `${baseUrl}/chat/completions`, model, external_retention: "provider_managed" }, sensitivity_floor: "public" },
  });
  configure(first.base_url, "alpha"); grant(first.base_url, "alpha", 0);
  db.query("UPDATE schedules SET enabled=0 WHERE rail <> 'sync'").run();
  let acquisitions = 0, closes = 0;
  const logs: string[] = [], visibleBindings: string[] = [], pids: number[] = [];
  try {
    const result = await runServeDaemon(db, setup.vault, {
      http: false,
      shouldContinue: () => {
        db.query("UPDATE schedules SET next_run_at=NULL WHERE rail='sync'").run();
        return closes < 5;
      },
      acquireRuntime: async () => {
        const phase = ++acquisitions;
        const epoch = sourcePolicyEpoch(db);
        const runtime = await createServeRuntime({ db, vaultPath: setup.vault, store, env: setup.env, err: line => logs.push(line), configurationErrorMode: "disable-model" });
        expect(sourcePolicyEpoch(db)).toBe(epoch);
        visibleBindings.push(JSON.stringify(runtime.hooks));
        pids.push(readServePid(setup.vault)!);
        if (phase === 1) {
          // Change both files after acquisition but before the first HTTP call.
          // The current attempt must keep alpha's endpoint AND the old credential.
          configure(second.base_url, "beta"); writeFileSync(secretPath, secondKey, { mode: 0o600 });
        }
        return { hooks: runtime.hooks, close: async () => {
          await runtime.close(); closes++;
          if (phase === 1) grant(second.base_url, "beta", 1);
          if (phase === 2) writeFileSync(configPath, '[ports]\nllm="kizuki.llm.none"\n');
          if (phase === 3) writeFileSync(configPath, '[ports.llm');
          if (phase === 4) configure(second.base_url, "beta");
          if (phase < 5) note(phase + 1);
        } };
      },
    });
    expect(result.receipts).toBe(5); expect(acquisitions).toBe(5); expect(closes).toBe(5);
    const receipts = listRunReceipts(db, { rail: "sync", limit: 10 });
    expect(receipts).toHaveLength(5);
    expect(receipts.map(row => row.events_stored)).toEqual([1, 1, 1, 1, 1]);
    expect(receipts.map(row => row.model.calls)).toEqual([1, 1, 0, 0, 1]);
    expect(receipts[2]!.model.model_ref).toBeNull();
    expect(receipts[3]!.model.model_ref).toBeNull();
    expect(receipts[3]!.status).toBe("degraded");
    expect(receipts[3]!.errors).toContain("model configuration unavailable");
    expect(receipts[4]!.status).toBe("ok");
    expect(first.requests).toHaveLength(1); expect(second.requests).toHaveLength(2);
    expect(first.requests[0]!.headers.authorization).toBe(`Bearer ${firstKey}`);
    expect(second.requests.every(request => request.headers.authorization === `Bearer ${secondKey}`)).toBe(true);
    expect(first.requests[0]!.body).toMatchObject({ model: "alpha" });
    expect(second.requests.every(request => (request.body as { model: string }).model === "beta")).toBe(true);
    expect(listClaims(db, { status: "live", limit: 20 }).some(claim => claim.producer === "model")).toBe(true);
    expect(inspectSourceGrant(db, source.source_key)?.revision).toBe(2);
    expect(new Set(pids).size).toBe(1);
    expect(new Set(receipts.map(row => row.execution?.instance_id)).size).toBe(1);
    expect(receipts.every(row => row.execution?.trigger === "scheduled")).toBe(true);
    expect(readServePid(setup.vault)).toBeNull(); expect(db.query("SELECT * FROM leases").all()).toHaveLength(0);
    const diagnostics = JSON.stringify([logs, visibleBindings, receipts, readFileSync(join(setup.vault, ".kizuki/run-receipts.jsonl"), "utf8")]);
    for (const key of [firstKey, secondKey, secretPath]) expect(diagnostics).not.toContain(key);
    const query = runCli(setup.env, "query", "library");
    expect(query.exitCode).toBe(0); expect(query.stdout).toContain("library");
  } finally { first.stop(); second.stop(); db.close(); }
}, 30_000);

test("strict runtime callers still reject invalid configuration, credentials, and endpoint binding", async () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  const options = { db, vaultPath: setup.vault, store: new ConnectionStateStore(join(setup.vault, ".kizuki")), env: setup.env, err: () => {} };
  const configs = [
    '[ports.llm',
    '[ports.llm]\nid="kizuki.llm.openai-compatible"\nmodel="broken"\n',
    '[ports.llm]\nid="kizuki.llm.openai-compatible"\nbase_url="http://127.0.0.1:1/v1"\nmodel="synthetic"\nsecret_ref="env:SYNTHETIC_MISSING_KEY"\n',
    '[ports.llm]\nid="kizuki.llm.openai-compatible"\nbase_url="http://192.0.2.1/v1"\nmodel="synthetic"\n',
  ];
  try {
    for (const config of configs) {
      writeFileSync(join(setup.vault, ".kizuki/serve.toml"), config);
      await expect(createServeRuntime(options)).rejects.toThrow();
      const disabled = await createServeRuntime({ ...options, configurationErrorMode: "disable-model" });
      try {
        expect(disabled.hooks.model_ref).toBeNull(); expect(disabled.hooks.producer).toBeUndefined();
        expect((await disabled.hooks.sync!()).errors).toEqual(["model configuration unavailable"]);
      } finally { await disabled.close(); }
    }
  } finally { db.close(); }
});
