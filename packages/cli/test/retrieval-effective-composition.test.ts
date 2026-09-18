import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfiguredRetrieval } from "@kizuki/core";
import { loadConfiguredEmbedding, openConfiguredEmbedding, openConfiguredRetrieval } from "../src/retrieval-runtime";
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
