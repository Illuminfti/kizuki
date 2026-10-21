import * as filesystem from "node:fs/promises";
import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCheckpoint, registerConnection, runToCompletion, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createMarkdownFolderConnector, createLegacyWikiConnector, MARKDOWN_FOLDER_CONNECTOR_ID } from "../src";

for (const mode of ["backfill", "sync"] as const) {
  test(`an exhausted Markdown ${mode} persists completion with excluded subtree coverage`, async () => {
    const root = await mkdtemp(join(tmpdir(), "kizuki-source-coverage-"));
    const ledger = join(root, "ledger.db");
    const notes = join(root, "notes");
    const source = "01JJ0000000000000000000001";
    let db = openLedger(ledger);
    try {
      await mkdir(join(notes, "excluded"), { recursive: true });
      await writeFile(join(notes, "included.md"), "Synthetic note");
      await writeFile(join(notes, "excluded", "hidden.md"), "Synthetic omitted note");
      registerConnection(db, MARKDOWN_FOLDER_CONNECTOR_ID, source);
      setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "coverage-consent", policy: {
        purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "metadata", "attachments"],
        retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
      } });
      const connector = createMarkdownFolderConnector({ path: notes, exclude: ["excluded"] });
      const result = await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, mode);
      expect(result).toMatchObject({ stored: 1, errors: [] });
      expect(getCheckpoint(db, MARKDOWN_FOLDER_CONNECTOR_ID, source)?.backfill_complete).toBe(true);
      expect(getCheckpoint(db, MARKDOWN_FOLDER_CONNECTOR_ID, source)?.last_result).toMatchObject({ coverage: {
        scan: { scanned: 1, failed: 0, pending: 0, excluded: expect.arrayContaining([{ rule: "exclude:excluded", count: 1 }]) },
        last_successful_pass_at: expect.any(String), last_error_class: null,
      } });
      db.close(); db = openLedger(ledger);
      expect(getCheckpoint(db, MARKDOWN_FOLDER_CONNECTOR_ID, source)?.backfill_complete).toBe(true);
      expect(getCheckpoint(db, MARKDOWN_FOLDER_CONNECTOR_ID, source)?.last_result).toHaveProperty("coverage.last_successful_pass_at");
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });
}


test("Markdown coverage reuses one directory inventory while draining pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "kizuki-coverage-walk-"));
  const listing = spyOn(filesystem, "readdir");
  try {
    for (const name of ["a", "b", "c"]) await writeFile(join(root, `${name}.md`), name);
    const connector = createMarkdownFolderConnector({ path: root, page_size: 1 });
    let batch = await connector.backfill(null);
    expect(batch.coverage).toMatchObject({ scanned: 3, pending: 2 });
    while (batch.has_more) batch = await connector.backfill(batch.cursor);
    expect(batch.coverage).toMatchObject({ scanned: 3, pending: 0 });
    expect(listing).toHaveBeenCalledTimes(1);
    await connector.sync(batch.cursor);
    expect(listing).toHaveBeenCalledTimes(2);
  } finally { listing.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("wiki coverage names excluded mapping roots and types and counts only observed entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "kizuki-wiki-coverage-"));
  try {
    await mkdir(join(root, "omitted"));
    await writeFile(join(root, "omitted", "hidden.md"), "Synthetic omitted note");
    await writeFile(join(root, "included.md"), "---\ntype: topic\n---\nSynthetic included note");
    await writeFile(join(root, "excluded.md"), "---\ntype: skip\n---\nSynthetic excluded note");
    await writeFile(join(root, "kizuki-mapping.json"), JSON.stringify({ schema: "kizuki.legacy-wiki-mapping/v1", ignore: ["omitted"], type: { field: "type", values: { topic: "topic", skip: null }, default: "topic" } }));
    const batch = await createLegacyWikiConnector({ path: root }).backfill(null);
    expect(batch.events).toHaveLength(1);
    expect(batch.coverage).toMatchObject({ scanned: 2, pending: 0, failed: 0, excluded: expect.arrayContaining([{ rule: "ignore:omitted", count: 1 }, { rule: "type_excluded:skip", count: 1 }]) });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a changed nested directory starts a new inventory without hiding identities below the cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "kizuki-coverage-new-inventory-"));
  const listing = spyOn(filesystem, "readdir");
  try {
    await mkdir(join(root, "nested"));
    for (const name of ["a", "z"]) await writeFile(join(root, "nested", `${name}.md`), name);
    const connector = createMarkdownFolderConnector({ path: root, page_size: 1 });
    const first = await connector.backfill(null);
    expect(first.events.map(event => event.source_record_id)).toEqual(["nested/a.md"]);
    await writeFile(join(root, "nested", "0.md"), "Synthetic new note");
    const second = await connector.backfill(first.cursor);
    expect(second.events.map(event => event.source_record_id)).toEqual(["nested/0.md"]);
    const last = await connector.backfill(second.cursor);
    expect(last.events.map(event => event.source_record_id)).toEqual(["nested/z.md"]);
    expect(last.has_more).toBe(false);
    expect(listing).toHaveBeenCalledTimes(4); // Two directories in each of two inventories.
  } finally { listing.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("an unreadable wiki record cannot declare a complete pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "kizuki-wiki-failed-"));
  try {
    await writeFile(join(root, "invalid.md"), Buffer.from([0xff]));
    await writeFile(join(root, "kizuki-mapping.json"), JSON.stringify({ schema: "kizuki.legacy-wiki-mapping/v1", type: { default: "topic" } }));
    const batch = await createLegacyWikiConnector({ path: root }).backfill(null);
    expect(batch.status).toBe("unavailable");
    expect(batch.has_more).not.toBe(false);
    expect(batch.coverage).toMatchObject({ failed: 1, pending: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a continued inventory revalidates bytes and retries after an interrupted pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "kizuki-coverage-drift-"));
  try {
    await writeFile(join(root, "a.md"), "Synthetic first note");
    await writeFile(join(root, "b.md"), "Synthetic original note");
    const connector = createMarkdownFolderConnector({ path: root, page_size: 1 });
    const first = await connector.backfill(null);
    await writeFile(join(root, "b.md"), "Synthetic changed note");
    const interrupted = await connector.backfill(first.cursor);
    expect(interrupted).toMatchObject({ events: [], cursor: first.cursor, status: "unavailable", coverage: { failed: 1, pending: 1 } });
    const resumed = await connector.backfill(first.cursor);
    expect(resumed.events.map(event => event.text)).toEqual(["Synthetic changed note"]);
    expect(resumed.has_more).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed Markdown pass uses one walk and never records successful completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "kizuki-coverage-partial-"));
  const listing = spyOn(filesystem, "readdir");
  const db = openLedger(":memory:");
  try {
    await writeFile(join(root, "valid.md"), "Synthetic readable note");
    await writeFile(join(root, "invalid.md"), Buffer.from([0xff]));
    const source = "01JJ0000000000000000000003";
    registerConnection(db, MARKDOWN_FOLDER_CONNECTOR_ID, source);
    setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "partial-consent", policy: {
      purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "metadata", "attachments"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
    } });
    const result = await runToCompletion(db, createMarkdownFolderConnector({ path: root }), MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill");
    expect(result.stored).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(getCheckpoint(db, MARKDOWN_FOLDER_CONNECTOR_ID, source)).toMatchObject({ backfill_complete: false,
      last_result: { coverage: { scan: { failed: 1 }, last_successful_pass_at: null, last_error_class: "unavailable" } } });
    expect(listing).toHaveBeenCalledTimes(1);
  } finally { listing.mockRestore(); db.close(); await rm(root, { recursive: true, force: true }); }
});

test("wiki inventory counts dot entries and the mapping file without reading their contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "kizuki-wiki-omissions-"));
  try {
    await mkdir(join(root, ".state"));
    await writeFile(join(root, ".state", "hidden.md"), "Synthetic omitted note");
    await writeFile(join(root, "kizuki-mapping.json"), JSON.stringify({ schema: "kizuki.legacy-wiki-mapping/v1", type: { default: "topic" } }));
    const batch = await createLegacyWikiConnector({ path: root }).backfill(null);
    expect(batch.coverage?.excluded).toEqual(expect.arrayContaining([{ rule: "dot_entries", count: 1 }, { rule: "mapping_file", count: 1 }]));
  } finally { await rm(root, { recursive: true, force: true }); }
});
