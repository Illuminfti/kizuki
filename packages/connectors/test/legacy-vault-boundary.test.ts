import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initVault } from "@kizuki/core";
import { createLegacyEventsConnector } from "../src/import-legacy-events";
import { LEGACY_EVENTS_FIXTURE, fixtureJsonl } from "../src/import-legacy-events/fixture";
import { createLegacyWikiConnector } from "../src/import-legacy-wiki";
import { LEGACY_WIKI_FIXTURE } from "../src/import-legacy-wiki/fixture";
import { scanLegacyWiki } from "../src/import-legacy-wiki/scan";

// Real ledger and vault work; bound it for a loaded host.
setDefaultTimeout(30_000);

const REFUSED = /source_contains_kizuki_vault/;
let root: string;

beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "kizuki-legacy-vault-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, content);
}

function wikiAt(directory: string): void {
  for (const file of LEGACY_WIKI_FIXTURE.files) write(join(directory, file.relpath), file.content);
  write(join(directory, "kizuki-mapping.json"), JSON.stringify({
    schema: "kizuki.legacy-wiki-mapping/v1",
    type: { field: "type", values: { Person: "person", Template: null }, default: "topic" },
    sensitivity: { field: "visibility", values: { friends: "personal" } },
    ignore: ["drafts/**", "ignored/**"],
  }));
}

/** A vault holding two machine pages, as a copy someone dropped into a wiki. */
function vaultWithPages(directory: string): void {
  initVault(directory);
  write(join(directory, "auto", "one.md"), "---\nid: 01J0000000000000000000000A\n---\nMachine prose one.\n");
  write(join(directory, "auto", "two.md"), "---\nid: 01J0000000000000000000000B\n---\nMachine prose two.\n");
}

describe("legacy wiki importer", () => {
  test("a clean wiki is still read", async () => {
    const wiki = join(root, "wiki");
    wikiAt(wiki);
    const batch = await createLegacyWikiConnector({ path: wiki }).backfill(null);
    expect(batch.events.length).toBeGreaterThan(0);
  });

  test("a source root that contains a vault is refused before any page is read", async () => {
    const wiki = join(root, "wiki");
    wikiAt(wiki);
    vaultWithPages(join(wiki, "copy"));
    await expect(createLegacyWikiConnector({ path: wiki }).backfill(null)).rejects.toThrow(REFUSED);
  });

  test("an ignore pattern cannot hide a nested vault", async () => {
    const wiki = join(root, "wiki");
    wikiAt(wiki);
    vaultWithPages(join(wiki, "ignored", "copy"));
    await expect(createLegacyWikiConnector({ path: wiki }).backfill(null)).rejects.toThrow(REFUSED);
    rmSync(join(wiki, "ignored"), { recursive: true });
    vaultWithPages(join(wiki, "drafts", "deep", "copy"));
    await expect(createLegacyWikiConnector({ path: wiki }).backfill(null)).rejects.toThrow(REFUSED);
  });

  test("an ignored tree too large to verify is refused, not passed", async () => {
    const wiki = join(root, "wiki");
    wikiAt(wiki);
    for (let index = 0; index < 6; index++) write(join(wiki, "ignored", `folder-${index}`, "note.md"), "x");
    await expect(scanLegacyWiki(wiki, ["ignored"], 3)).rejects.toThrow(/source_path_depth/);
    expect((await scanLegacyWiki(wiki, ["ignored"], 100)).files.length).toBeGreaterThan(0);
  });

  test("a source root inside a vault, or the vault itself, is refused", async () => {
    const vault = join(root, "vault");
    vaultWithPages(vault);
    wikiAt(join(vault, "wiki"));
    await expect(createLegacyWikiConnector({ path: join(vault, "wiki") }).backfill(null)).rejects.toThrow(REFUSED);
    write(join(vault, "kizuki-mapping.json"), JSON.stringify({ schema: "kizuki.legacy-wiki-mapping/v1", type: { field: "type", values: {}, default: "topic" } }));
    await expect(createLegacyWikiConnector({ path: vault }).backfill(null)).rejects.toThrow(REFUSED);
  });

  test("a symlinked source root resolves before the check", async () => {
    const vault = join(root, "vault");
    vaultWithPages(vault);
    wikiAt(join(vault, "wiki"));
    symlinkSync(join(vault, "wiki"), join(root, "alias"));
    await expect(createLegacyWikiConnector({ path: join(root, "alias") }).backfill(null)).rejects.toThrow(REFUSED);
  });
});

describe("legacy events importer", () => {
  function source(directory: string): string {
    const file = join(directory, "legacy.jsonl");
    write(file, fixtureJsonl());
    writeFileSync(`${file}.kizuki-mapping.json`, JSON.stringify({ ...LEGACY_EVENTS_FIXTURE.mapping, table: null }));
    return file;
  }

  test("an export outside any vault is still read", async () => {
    const batch = await createLegacyEventsConnector({ path: source(join(root, "export")) }).backfill(null);
    expect(batch.events.length).toBeGreaterThan(0);
  });

  test("an export inside a vault, including the vault's own control data, is refused", async () => {
    const vault = join(root, "vault");
    initVault(vault);
    await expect(createLegacyEventsConnector({ path: source(join(vault, "notes")) }).backfill(null)).rejects.toThrow(REFUSED);
    const control = join(vault, ".kizuki", "legacy.jsonl");
    copyFileSync(source(join(root, "export")), control);
    copyFileSync(`${join(root, "export", "legacy.jsonl")}.kizuki-mapping.json`, `${control}.kizuki-mapping.json`);
    await expect(createLegacyEventsConnector({ path: control }).backfill(null)).rejects.toThrow(REFUSED);
  });
});
