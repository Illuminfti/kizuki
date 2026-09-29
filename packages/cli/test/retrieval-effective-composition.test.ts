import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfiguredRetrieval } from "@kizuki/core";
import { embeddingConfigured, loadConfiguredEmbedding, openConfiguredEmbedding, openConfiguredRetrieval } from "../src/retrieval-runtime";
import { loadVaultConfig } from "../src/vault-config";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function emptyVault(): string {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-composition-"));
  directories.push(directory);
  return directory;
}

test("default CLI composition binds no retrieval engine and no embedding model", async () => {
  const vault = emptyVault();
  const ports = loadVaultConfig(vault).ports;
  expect(ports.retrieval).toBe("kizuki.retrieval.fts5");
  expect(ports.embedding).toBe("kizuki.embedding.none");
  expect(loadConfiguredRetrieval(vault)).toEqual({ id: "kizuki.retrieval.fts5", config: {} });
  expect(loadConfiguredEmbedding(vault)).toEqual({ id: "kizuki.embedding.none", config: {} });
  expect(await openConfiguredRetrieval(vault)).toBeUndefined();
  expect(await openConfiguredEmbedding(vault)).toBeUndefined();
});

const LOCAL_HTTP = `[ports.embedding]
id = "kizuki.embedding.local-http"
api = "openai"
endpoint = "http://127.0.0.1:9"
model = "synthetic-embed"
dims = 8
max_input_tokens = 512
`;

test("the local HTTP embedding port is a known choice that binds without contacting its server", async () => {
  const vault = emptyVault();
  mkdirSync(join(vault, ".kizuki"), { recursive: true });
  writeFileSync(join(vault, ".kizuki", "serve.toml"), `[ports]\nretrieval = "kizuki.retrieval.embedded-pg"\n\n${LOCAL_HTTP}`);
  expect(loadVaultConfig(vault).ports.embedding).toBe("kizuki.embedding.local-http");
  expect(embeddingConfigured(vault)).toBe(true);
  // Nothing listens on port 9: binding must not need the server.
  const embedding = await openConfiguredEmbedding(vault);
  expect(embedding?.space().id).toMatch(/^local-http:synthetic-embed@8#/);
  expect(embedding?.countTokens?.("grace runs partnerships")).toBeGreaterThan(0);
  await embedding?.close();
});

test("the engine is bound with the configured embedding port, its memory bound and shared ownership", async () => {
  const vault = emptyVault();
  mkdirSync(join(vault, ".kizuki"), { recursive: true });
  writeFileSync(
    join(vault, ".kizuki", "serve.toml"),
    `[ports.retrieval]\nid = "kizuki.retrieval.embedded-pg"\nmax_text_bytes = 2097152\n\n${LOCAL_HTTP}`,
  );
  const retrieval = await openConfiguredRetrieval(vault);
  expect(retrieval?.descriptor.supports).toEqual(expect.arrayContaining(["vector", "hybrid"]));
  const health = await retrieval!.health();
  expect(health.status === "ready" && health.detail["max_text_bytes"]).toBe(2_097_152);
  await retrieval!.close();

  // Without an embedding port the same engine offers no vector lane.
  writeFileSync(join(vault, ".kizuki", "serve.toml"), `[ports]\nretrieval = "kizuki.retrieval.embedded-pg"\n`);
  const lexical = await openConfiguredRetrieval(vault);
  expect(lexical?.descriptor.supports).not.toContain("vector");
  await lexical!.close();
}, 120_000);

test("an unreadable embedding selection stops the engine from binding instead of hiding the mistake", async () => {
  const vault = emptyVault();
  mkdirSync(join(vault, ".kizuki"), { recursive: true });
  writeFileSync(join(vault, ".kizuki", "serve.toml"), `[ports]\nretrieval = "kizuki.retrieval.embedded-pg"\nembedding = "kizuki.embedding.typo"\n`);
  await expect(openConfiguredRetrieval(vault)).rejects.toMatchObject({ code: "config_invalid" });
});
