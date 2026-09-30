import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLegacyWikiConnector, createMarkdownFolderConnector } from "../src";

test("a wiki backfill enumerates its tree once while draining capture pages", async () => {
  const source = mkdtempSync(join(tmpdir(), "kizuki-wiki-drain-"));
  const listing = spyOn(filesystem, "readdir");
  try {
    writeFileSync(join(source, "kizuki-mapping.json"), JSON.stringify({
      schema: "kizuki.legacy-wiki-mapping/v1", type: { default: "topic" },
    }));
    mkdirSync(join(source, "pages"));
    for (let index = 0; index < 1005; index++) writeFileSync(join(source, "pages", `${index}.md`), `---\ntitle: Page ${index}\n---\nsynthetic page ${index}\n`);
    const connector = createLegacyWikiConnector({ path: source });
    let batch = await connector.backfill(null);
    let emitted = batch.events.length;
    while (batch.has_more) {
      batch = await connector.backfill(batch.cursor);
      emitted += batch.events.length;
    }
    expect(emitted).toBe(1005);
    // The root and its one child are each listed only once.
    expect(listing).toHaveBeenCalledTimes(2);
  } finally {
    listing.mockRestore();
    rmSync(source, { recursive: true, force: true });
  }
});

test("a folder drain discards its snapshot when the root is replaced", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-folder-drain-"));
  const source = join(root, "source");
  try {
    mkdirSync(source);
    for (const name of ["a", "b", "c"]) writeFileSync(join(source, `${name}.md`), `${name}\n`);
    const connector = createMarkdownFolderConnector({ path: source, page_size: 1 });
    const first = await connector.backfill(null);
    renameSync(source, join(root, "old"));
    mkdirSync(source);
    writeFileSync(join(source, "d.md"), "replacement\n");
    const second = await connector.backfill(first.cursor);
    expect(second.events.map((event) => event.source_record_id)).toEqual(["d.md"]);
    expect(second.events.some((event) => event.deleted)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a file changed during a folder drain is retried from a fresh scan", async () => {
  const source = mkdtempSync(join(tmpdir(), "kizuki-folder-drain-"));
  try {
    writeFileSync(join(source, "a.md"), "a\n");
    writeFileSync(join(source, "b.md"), "before\n");
    const connector = createMarkdownFolderConnector({ path: source, page_size: 1 });
    const first = await connector.backfill(null);
    writeFileSync(join(source, "b.md"), "after\n");
    const changed = await connector.backfill(first.cursor);
    expect(changed.events).toEqual([]);
    expect(changed.status).toBe("unavailable");
    expect(changed.cursor).toBe(first.cursor);
    const retried = await connector.backfill(first.cursor);
    expect(retried.events.map((event) => event.text)).toEqual(["after\n"]);
  } finally { rmSync(source, { recursive: true, force: true }); }
});
