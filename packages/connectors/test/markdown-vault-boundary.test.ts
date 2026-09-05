import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initVault } from "@kizuki/core";
import { createMarkdownFolderConnector } from "../src/markdown-folder";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync("/tmp/kizuki-markdown-vault-"), vault = join(root, "vault");
  roots.push(root); initVault(vault); mkdirSync(join(vault, "auto"));
  writeFileSync(join(vault, "auto", "synthetic.md"), "SYNTHETIC_GENERATED_CANON\n");
  writeFileSync(join(root, "first.md"), "SYNTHETIC_ORDINARY_SOURCE\n");
  return { root, vault };
}

test("a vault, its descendants, and a scanned ancestor refuse the whole capture", async () => {
  const { root, vault } = fixture();
  for (const source of [vault, join(vault, "auto"), join(vault, "archive"), join(vault, ".kizuki"), root]) {
    const connector = createMarkdownFolderConnector({ path: source });
    await expect(connector.backfill(null)).rejects.toThrow("source_contains_kizuki_vault");
    expect((await connector.health()).state).toBe("misconfigured");
  }
});

test("aliases and excluded control names cannot hide vault identity", async () => {
  const { root, vault } = fixture();
  const alias = join(root, "alias"); symlinkSync(join(vault, "auto"), alias);
  await expect(createMarkdownFolderConnector({ path: alias }).backfill(null)).rejects.toThrow("source_contains_kizuki_vault");
  await expect(createMarkdownFolderConnector({ path: vault, exclude: [".kizuki"] }).backfill(null)).rejects.toThrow("source_contains_kizuki_vault");
  const source = mkdtempSync("/tmp/kizuki-markdown-control-"); roots.push(source);
  writeFileSync(join(source, "note.md"), "SYNTHETIC_SOURCE\n");
  symlinkSync(join(source, "absent-control-target"), join(source, ".kizuki"));
  await expect(createMarkdownFolderConnector({ path: source }).backfill(null)).rejects.toThrow("source_contains_kizuki_vault");
});

test("a source becoming a vault refuses restart without turning prior notes into tombstones", async () => {
  const source = mkdtempSync("/tmp/kizuki-markdown-source-"); roots.push(source);
  writeFileSync(join(source, "note.md"), "SYNTHETIC_SOURCE\n");
  const connector = createMarkdownFolderConnector({ path: source });
  const first = await connector.backfill(null);
  expect(first.events).toHaveLength(1);
  mkdirSync(join(source, ".kizuki"));
  await expect(connector.sync(first.cursor)).rejects.toThrow("source_contains_kizuki_vault");
  rmSync(join(source, ".kizuki"), { recursive: true });
  expect((await connector.sync(first.cursor)).events).toEqual([]);
});

test("an independent sibling folder remains a usable source", async () => {
  const { root } = fixture();
  const source = join(root, "notes"); mkdirSync(source);
  writeFileSync(join(source, "note.md"), "SYNTHETIC_SIBLING_SOURCE\n");
  const result = await createMarkdownFolderConnector({ path: source }).backfill(null);
  expect(result.events.map(event => event.text)).toEqual(["SYNTHETIC_SIBLING_SOURCE\n"]);
});
