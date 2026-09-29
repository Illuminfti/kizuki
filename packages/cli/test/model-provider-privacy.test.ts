import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelSelection, readModelSettings, saveModelSettings } from "../src/app/model-settings";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function vault(raw: string) {
  const root = mkdtempSync(join(tmpdir(), "model-provider-")); roots.push(root);
  mkdirSync(join(root, ".kizuki"), { mode: 0o700 });
  writeFileSync(join(root, ".kizuki/serve.toml"), raw, { mode: 0o600 });
  return root;
}
const model = 'id = "kizuki.llm.openai-compatible"\nbase_url = "https://models.example.test/v1"\nmodel = "synthetic"\n';
const table = '[ports.llm.provider]\ndata_collection = "deny"\nzdr = true\nignore = ["one", "two"]\n';

test("provider privacy controls do not change the endpoint and model that source consent names", async () => {
  const selections = [];
  for (const raw of [`[ports.llm]\n${model}`, `[ports.llm]\n${model}${table}`, `[ports.llm]\n${model}[ports.llm.provider]\ndata_collection = "allow"\n`]) {
    selections.push(readModelSelection(vault(raw)).selection);
  }
  expect(selections[0]).toEqual({ kind: "openai_compatible", base_url: "https://models.example.test/v1", model: "synthetic", model_endpoint: "https://models.example.test/v1/chat/completions" });
  expect(selections[1]).toEqual(selections[0]!);
  expect(selections[2]).toEqual(selections[0]!);
});

test("a model change keeps the provider table byte-for-byte meaningful and the surrounding settings", async () => {
  const raw = `# kept\n[serve]\nhttp = false\n[ports.llm]\n${model}timeout_ms = 2300\n${table}[budget]\ncanon_writes_per_run = 9\n`;
  const root = vault(raw), before = await readModelSettings(root);
  await saveModelSettings(root, { expected_revision: before.revision, selection: { kind: "openai_compatible", base_url: "https://other.example.test/v1", model: "next" }, credential: { action: "keep" } });
  const stored = readFileSync(join(root, ".kizuki/serve.toml"), "utf8");
  expect(stored.startsWith("# kept\n[serve]\nhttp = false\n")).toBe(true);
  expect(stored.endsWith("[budget]\ncanon_writes_per_run = 9\n")).toBe(true);
  expect(Bun.TOML.parse(stored)).toMatchObject({ ports: { llm: { base_url: "https://other.example.test/v1", model: "next", timeout_ms: 2300, provider: { data_collection: "deny", zdr: true, ignore: ["one", "two"] } } } });
});

test("an inline provider table survives a model change as a provider table", async () => {
  const root = vault(`[ports.llm]\n${model}provider = { data_collection = "deny", zdr = true }\n`), before = await readModelSettings(root);
  await saveModelSettings(root, { expected_revision: before.revision, selection: { kind: "openai_compatible", base_url: "https://models.example.test/v1", model: "next" }, credential: { action: "keep" } });
  expect(Bun.TOML.parse(readFileSync(join(root, ".kizuki/serve.toml"), "utf8"))).toMatchObject({ ports: { llm: { model: "next", provider: { data_collection: "deny", zdr: true } } } });
});

test("an unknown or malformed provider key makes the model configuration invalid", async () => {
  for (const bad of ['[ports.llm.provider]\ndata_colection = "deny"\n', '[ports.llm.provider]\ndata_collection = "sometimes"\n', '[ports.llm.provider]\norder = []\n']) {
    await expect(readModelSettings(vault(`[ports.llm]\n${model}${bad}`))).rejects.toThrow("configuration_invalid");
  }
});
