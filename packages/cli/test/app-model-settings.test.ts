import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelSelection, readModelSettings, saveModelSettings, testModelSettings } from "../src/app/model-settings";
import { withVaultMutationAsync } from "../../core/src/vault/mutation-scope";

const roots: string[] = [], servers: { stop(close?: boolean): void }[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(raw?: string) {
  const root = mkdtempSync(join(tmpdir(), "app-model-")); roots.push(root);
  mkdirSync(join(root, ".kizuki"), { mode: 0o700 });
  if (raw !== undefined) writeFileSync(join(root, ".kizuki/serve.toml"), raw, { mode: 0o600 });
  return root;
}
function endpoint(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }); servers.push(server);
  return `http://127.0.0.1:${server.port}/v1`;
}
function complete(text = "OK", model = "synthetic") {
  return new Response(JSON.stringify({ id: "synthetic", object: "chat.completion", model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { "content-type": "application/json" } });
}
const selection = (base_url: string, model = "synthetic") => ({ kind: "openai_compatible" as const, base_url, model });

test("model settings are off by default and saving is offline, private and grants nothing", async () => {
  const root = fixture(); let requests = 0;
  const url = endpoint(() => { requests++; return complete(); });
  expect(await readModelSettings(root)).toEqual({ revision: "absent", selection: { kind: "none" }, credential: "none", last_test: null });
  const saved = await saveModelSettings(root, { expected_revision: "absent", selection: selection(url), credential: { action: "replace", value: "synthetic-password-one" } });
  expect(saved).toMatchObject({ selection: { ...selection(url), model_endpoint: `${url}/chat/completions` }, credential: "configured", last_test: null });
  expect(readModelSelection(root)).toEqual({ revision: saved.revision, selection: saved.selection });
  expect(requests).toBe(0); expect(existsSync(join(root, ".kizuki/ledger.sqlite"))).toBe(false);
  const raw = JSON.stringify(saved);
  for (const forbidden of ["synthetic-password-one", "file:", "secret_ref", ".key"]) expect(raw).not.toContain(forbidden);
  const tested = await testModelSettings(root, saved.revision);
  expect(tested.outcome).toBe("succeeded"); expect(requests).toBe(1);
  expect((await readModelSettings(root)).last_test).toBeNull();
});

test("normal canon writer ownership does not make clean model status unavailable", async () => {
  const root = fixture(), saved = await saveModelSettings(root, { expected_revision: "absent", selection: selection("http://127.0.0.1:12345/v1"), credential: { action: "replace", value: "synthetic-reader-key" } });
  await withVaultMutationAsync({ vault_path: root }, async () => {
    expect(await readModelSettings(root)).toEqual(saved);
    expect(readModelSelection(root)).toEqual({ revision: saved.revision, selection: saved.selection });
  });
});

test("model saves preserve unrelated settings and timeout/retry configuration with raw-byte CAS", async () => {
  const url = endpoint(() => complete());
  const raw = '# retained\r\n[serve]\r\nhttp = false\r\n[ports.llm]\r\nid = "kizuki.llm.openai-compatible"\r\nbase_url = "http://127.0.0.1:1/v1"\r\nmodel = "old"\r\ntimeout_ms = 2300\r\nmax_retries = 4\r\n[budget]\r\ncanon_writes_per_run = 9\r\n';
  const root = fixture(raw), before = await readModelSettings(root);
  const next = await saveModelSettings(root, { expected_revision: before.revision, selection: selection(url), credential: { action: "keep" } });
  const stored = readFileSync(join(root, ".kizuki/serve.toml"), "utf8");
  expect(stored.startsWith('# retained\r\n[serve]\r\nhttp = false\r\n')).toBe(true);
  expect(stored.endsWith('[budget]\r\ncanon_writes_per_run = 9\r\n')).toBe(true);
  expect(Bun.TOML.parse(stored)).toMatchObject({ ports: { llm: { timeout_ms: 2300, max_retries: 4 } } });
  writeFileSync(join(root, ".kizuki/serve.toml"), `${stored}# byte change only\n`);
  await expect(saveModelSettings(root, { expected_revision: next.revision, selection: { kind: "none" }, credential: { action: "keep" } })).rejects.toThrow("revision_conflict");
});

test("invalid existing config and invalid input cannot silently replace settings", async () => {
  for (const raw of ['broken = [', '[ports.llm]\nid = "unknown"\n', '[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "http://127.0.0.1"\nmodel = "synthetic"\nunknown = true\n']) {
    const root = fixture(raw);
    await expect(readModelSettings(root)).rejects.toThrow("configuration_invalid");
    await expect(saveModelSettings(root, { expected_revision: "absent", selection: { kind: "none" }, credential: { action: "clear" } })).rejects.toThrow("configuration_invalid");
    expect(readFileSync(join(root, ".kizuki/serve.toml"), "utf8")).toBe(raw);
  }
  const root = fixture();
  await expect(saveModelSettings(root, { expected_revision: "absent", selection: { kind: "none" }, credential: { action: "replace", value: "synthetic-key" } })).rejects.toThrow("credential_invalid");
  await expect(saveModelSettings(root, { expected_revision: "absent", selection: selection("https://user:secret@example.test/v1"), credential: { action: "clear" } })).rejects.toThrow("configuration_invalid");
  await expect(saveModelSettings(root, { expected_revision: "absent", selection: selection("http://example.test/v1"), credential: { action: "clear" } })).rejects.toThrow("configuration_invalid");
  await expect(saveModelSettings(root, { expected_revision: "absent", selection: selection("https://example.test/v1"), credential: { action: "replace", value: "x".repeat(1025) } })).rejects.toThrow("credential_invalid");
  expect(existsSync(join(root, ".kizuki/serve.toml"))).toBe(false);
});

test("synthetic tests use one immutable model and credential snapshot and discard provider content", async () => {
  const root = fixture();
  let arrived!: () => void, release!: () => void;
  const received = new Promise<void>(resolve => { arrived = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  const observed: { authorization: string | null; path: string; body: unknown }[] = [];
  const first = endpoint(async request => {
    observed.push({ authorization: request.headers.get("authorization"), path: new URL(request.url).pathname, body: await request.json() });
    arrived(); await hold; return complete("provider echoed synthetic-password-one and private response", "first");
  });
  let secondCalls = 0; const second = endpoint(() => { secondCalls++; return complete(); });
  const saved = await saveModelSettings(root, { expected_revision: "absent", selection: selection(first, "first"), credential: { action: "replace", value: "synthetic-password-one" } });
  const pending = testModelSettings(root, saved.revision);
  try {
    await received;
    const changed = await saveModelSettings(root, { expected_revision: saved.revision, selection: selection(second, "second"), credential: { action: "replace", value: "synthetic-password-two" } });
    release(); const result = await pending;
    expect(result).toMatchObject({ revision: saved.revision, outcome: "succeeded", error_code: null });
    expect(result.revision).not.toBe(changed.revision); expect(secondCalls).toBe(0);
    expect(observed).toEqual([{ authorization: "Bearer synthetic-password-one", path: "/v1/chat/completions", body: { model: "first", max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK. This is a synthetic connection test containing no personal data." }] } }]);
    for (const forbidden of ["synthetic-password-one", "synthetic-password-two", "private response", "file:", "secret_ref"]) expect(JSON.stringify(result)).not.toContain(forbidden);
    expect((await readModelSettings(root)).last_test).toBeNull();
    await expect(testModelSettings(root, saved.revision)).rejects.toThrow("revision_conflict");
  } finally { release(); }
});

test("failed synthetic tests do not retry, leak remote errors, or contact a model when disabled", async () => {
  const root = fixture(); let requests = 0;
  const url = endpoint(() => { requests++; return new Response('secret_ref=file:/private/key synthetic-password', { status: 503 }); });
  const saved = await saveModelSettings(root, { expected_revision: "absent", selection: selection(url), credential: { action: "clear" } });
  const failed = await testModelSettings(root, saved.revision);
  expect(failed).toMatchObject({ outcome: "failed", error_code: "model_test_failed" }); expect(requests).toBe(1);
  expect(JSON.stringify(failed)).not.toContain("private"); expect(JSON.stringify(failed)).not.toContain("synthetic-password");
  const off = await saveModelSettings(root, { expected_revision: saved.revision, selection: { kind: "none" }, credential: { action: "keep" } });
  expect(await testModelSettings(root, off.revision)).toMatchObject({ outcome: "failed", error_code: "model_unconfigured" }); expect(requests).toBe(1);
});

test("missing existing credential stays unavailable and clear/keep never expose its reference", async () => {
  const url = endpoint(() => { throw Error("must not call"); });
  const root = fixture(`[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "${url}"\nmodel = "synthetic"\nsecret_ref = "env:SYNTHETIC_MISSING_KEY"\n`);
  const before = await readModelSettings(root);
  expect(before.credential).toBe("unavailable"); expect(JSON.stringify(before)).not.toContain("SYNTHETIC_MISSING_KEY");
  expect(await testModelSettings(root, before.revision)).toMatchObject({ outcome: "failed", error_code: "credential_unavailable" });
  const kept = await saveModelSettings(root, { expected_revision: before.revision, selection: { kind: "none" }, credential: { action: "keep" } });
  expect(kept.credential).toBe("unavailable");
  const cleared = await saveModelSettings(root, { expected_revision: kept.revision, selection: { kind: "none" }, credential: { action: "clear" } });
  expect(cleared.credential).toBe("none"); expect(readFileSync(join(root, ".kizuki/serve.toml"), "utf8")).not.toContain("secret_ref");
});

test("concurrent saves admit only one exact revision and leave no unfinished transaction", async () => {
  const root = fixture(), first = selection("http://127.0.0.1:12345/v1", "first"), second = selection("http://127.0.0.1:12345/v1", "second");
  const results = await Promise.allSettled([first, second].map(selected => saveModelSettings(root, {
    expected_revision: "absent", selection: selected, credential: { action: "replace", value: "synthetic-race-token" },
  })));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason.message).toBe("revision_conflict");
  expect(existsSync(join(root, ".kizuki/app-model/transaction.json"))).toBe(false);
});

test("the real synthetic model request stops at its fifteen-second deadline", async () => {
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const url = endpoint(async () => { requests++; await hold; return complete(); });
  const root = fixture(), saved = await saveModelSettings(root, { expected_revision: "absent", selection: selection(url), credential: { action: "clear" } });
  try {
    const result = await testModelSettings(root, saved.revision);
    expect(result).toMatchObject({ outcome: "failed", error_code: "model_test_failed" });
    expect(result.latency_ms).toBeGreaterThanOrEqual(14_000);
    expect(result.latency_ms).toBeLessThan(19_000);
    expect(requests).toBe(1);
  } finally { release(); }
}, 20_000);

test("managed credential aliases cannot use the connection test to bypass directory custody", async () => {
  const root = fixture(); let requests = 0;
  const url = endpoint(() => { requests++; return complete(); });
  await saveModelSettings(root, { expected_revision: "absent", selection: selection(url), credential: { action: "replace", value: "synthetic-alias-key" } });
  const path = join(root, ".kizuki/serve.toml"), original = readFileSync(path, "utf8");
  const parsed = Bun.TOML.parse(original) as { ports: { llm: { secret_ref: string } } }, reference = parsed.ports.llm.secret_ref;
  const outside = fixture(), link = join(outside, "alias");
  symlinkSync(join(root, ".kizuki/app-model"), link);
  chmodSync(join(root, ".kizuki/app-model"), 0o755);
  for (const alias of [reference, reference.replace("/.kizuki/", "//.kizuki/"), `file:${link}/${reference.split("/").at(-1)}`]) {
    writeFileSync(path, original.replace(reference, alias));
    const current = await readModelSettings(root);
    expect(current.credential).toBe("unavailable");
    expect(await testModelSettings(root, current.revision)).toMatchObject({ outcome: "failed", error_code: "credential_unavailable" });
  }
  expect(requests).toBe(0);
});

test("direct external file and env credentials still bind once through the actual model test", async () => {
  const seen: string[] = [], url = endpoint(request => { seen.push(request.headers.get("authorization")!); return complete(); });
  const outside = fixture(), path = join(outside, "external.key");
  writeFileSync(path, " synthetic-external-model-key\n", { mode: 0o400 });
  for (const reference of [`file:${path}`, "env:SYNTHETIC_MODEL_KEY"]) {
    const root = fixture(`[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "${url}"\nmodel = "synthetic"\nsecret_ref = ${JSON.stringify(reference)}\n`);
    const env = { SYNTHETIC_MODEL_KEY: "synthetic-external-model-key" }, current = await readModelSettings(root, env);
    expect(current.credential).toBe("configured");
    expect(await testModelSettings(root, current.revision, env)).toMatchObject({ outcome: "succeeded", error_code: null });
  }
  expect(seen).toEqual(["Bearer synthetic-external-model-key", "Bearer synthetic-external-model-key"]);
});
