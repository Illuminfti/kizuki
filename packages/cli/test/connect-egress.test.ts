import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "./helpers";

setDefaultTimeout(30_000);

const h = createHelpers();
afterEach(h.cleanup);

const ENDPOINT = "https://models.example.test/v1/chat/completions";
const MODEL = "synthetic-model";
const local = { purposes: ["capture", "recall", "extract"], allowed_fields: ["text"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" };
const remote = { ...local, egress: { model_endpoint: ENDPOINT, model: MODEL, external_retention: "provider_managed" } };
const llm = 'id = "kizuki.llm.openai-compatible"\nbase_url = "https://models.example.test/v1"\nmodel = "synthetic-model"\n';

function source() {
  const f = h.tempVault();
  const connected = h.runCli(f.env, "connect", "markdown-folder", "--source", f.notes);
  expect(connected.exitCode).toBe(0);
  return { ...f, key: connected.stdout.match(/source=([0-9A-HJKMNP-TV-Z]{26})/)![1]! };
}
function grant(f: ReturnType<typeof source>, policy: unknown, expected = 0) {
  const file = join(f.root, `policy-${expected}.json`);
  writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  const result = h.runCli(f.env, "connect", "grant", "--source", f.key, "--policy", file, "--expected-revision", String(expected), "--operation-id", `egress-${expected}`);
  expect(result.exitCode, result.stderr).toBe(0);
}
const configure = (f: ReturnType<typeof source>, body: string) => writeFileSync(join(f.vault, ".kizuki", "serve.toml"), body, { mode: 0o600 });
const egress = (f: ReturnType<typeof source>) => JSON.parse(h.runCli(f.env, "connect", "status", "--json").stdout).data.connections[0].egress;
const row = (f: ReturnType<typeof source>) => h.runCli(f.env, "connect", "status").stdout;

test("a source without consent shows no destination", () => {
  const f = source();
  expect(egress(f)).toEqual({ destination: "none", host: null, model: null, retention: "none", provider_controls: null, configured: false });
  expect(row(f)).toContain("Egress");
  expect(row(f)).toContain("Retention");
});

test("a local-only grant says local only and no retention", () => {
  const f = source();
  grant(f, local);
  expect(egress(f)).toMatchObject({ destination: "local_only", host: null, model: null, retention: "none" });
  expect(row(f)).toContain("local only");
});

test("a model grant names its host, model, retention and the provider controls the configured model requests", () => {
  const f = source();
  grant(f, remote);
  configure(f, `[ports.llm]\n${llm}[ports.llm.provider]\ndata_collection = "deny"\nzdr = true\n`);
  expect(egress(f)).toEqual({ destination: "model_endpoint", host: "models.example.test", model: MODEL, retention: "provider_managed", provider_controls: { data_collection: "deny", zdr: true }, configured: true });
  const text = row(f);
  expect(text).toContain("models.example.test synthetic-model");
  expect(text).toContain("provider-managed; requests data_collection=deny zdr=true");
});

test("a model grant without provider controls says none are requested", () => {
  const f = source();
  grant(f, remote);
  configure(f, `[ports.llm]\n${llm}`);
  expect(egress(f)).toMatchObject({ destination: "model_endpoint", provider_controls: null, configured: true });
  expect(row(f)).toContain("provider-managed; no provider controls requested");
});

test("a granted model that is not the configured one is shown as dormant", () => {
  const f = source();
  grant(f, remote);
  expect(egress(f)).toMatchObject({ destination: "model_endpoint", host: "models.example.test", configured: false, provider_controls: null });
  expect(row(f)).toContain("(not the configured model)");
  configure(f, `[ports.llm]\n${llm.replace("synthetic-model", "another-model")}[ports.llm.provider]\nzdr = true\n`);
  expect(egress(f)).toMatchObject({ configured: false, provider_controls: null });
});

test("a revoked source shows no destination again", () => {
  const f = source();
  grant(f, remote);
  const revoked = h.runCli(f.env, "connect", "revoke", "--source", f.key, "--expected-revision", "1", "--operation-id", "egress-revoke");
  expect(revoked.exitCode, revoked.stderr).toBe(0);
  expect(egress(f)).toMatchObject({ destination: "none", retention: "none" });
});

test("connect status --source reports the same egress view", () => {
  const f = source();
  grant(f, remote);
  configure(f, `[ports.llm]\n${llm}[ports.llm.provider]\ndata_collection = "deny"\n`);
  const json = JSON.parse(h.runCli(f.env, "connect", "status", "--source", f.key, "--json").stdout).data;
  expect(json.egress).toMatchObject({ destination: "model_endpoint", model: MODEL, provider_controls: { data_collection: "deny" } });
  const text = h.runCli(f.env, "connect", "status", "--source", f.key).stdout;
  expect(text).toContain("egress=models.example.test synthetic-model");
  expect(text).toContain("retention=provider-managed; requests data_collection=deny");
});
