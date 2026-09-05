import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfiguredRetrieval } from "../../src/retrieval/config";
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });
function vault(contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), "retrieval-config-")); roots.push(root);
  mkdirSync(join(root, ".kizuki"));
  if (contents !== undefined) writeFileSync(join(root, ".kizuki", "serve.toml"), contents);
  return root;
}
test("CLI and MCP selection has an explicit offline default", () => {
  expect(loadConfiguredRetrieval(vault())).toEqual({ id: "kizuki.retrieval.fts5", config: {} });
  expect(loadConfiguredRetrieval(vault('[ports]\nllm="kizuki.llm.none"'))).toEqual({ id: "kizuki.retrieval.fts5", config: {} });
});
test("string and table configuration identify the real SQL engine", () => {
  for (const value of ['[ports]\nretrieval="kizuki.retrieval.embedded-pg"', '[ports.retrieval]\nid="kizuki.retrieval.embedded-pg"', '[ports]\nretrieval="kizuki.retrieval.pg"']) {
    expect(loadConfiguredRetrieval(vault(value)).id).toBe("kizuki.retrieval.embedded-pg");
  }
});
test("invalid configuration cannot silently turn the selected capability off", () => {
  for (const value of ['broken = [', 'ports = "bad"', '[ports]\nretrieval = 3', '[ports.retrieval]\nother = "bad"', 'x'.repeat(65_537)]) {
    expect(() => loadConfiguredRetrieval(vault(value))).toThrow();
  }
});
