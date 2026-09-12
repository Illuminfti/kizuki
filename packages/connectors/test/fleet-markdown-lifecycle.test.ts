import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_CURSOR_BYTES,
  MAX_SYNC_BATCH_BYTES,
  getCheckpoint,
  registerConnection,
  runBatch,
  runToCompletion,
  setSourceGrant,
  sourceCaptureAdmission,
  type SyncBatch,
} from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { markdownCommittedIdentities } from "../../cli/src/connections";
import {
  MARKDOWN_FOLDER_CONNECTOR_ID,
  createMarkdownFolderConnector,
} from "../src";
import { MAX_FILE_BYTES } from "../src/markdown-folder";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function syntheticDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function named<T extends { source_record_id: string }>(
  events: readonly T[],
  source_record_id: string,
): T {
  const event = events.find((item) => item.source_record_id === source_record_id);
  if (event === undefined) {
    throw new Error(`expected event ${source_record_id}`);
  }
  return event;
}

function idsOf(events: readonly { source_record_id: string }[]): string[] {
  return events.map((event) => event.source_record_id).sort();
}

function requireCursor(cursor: string | null): string {
  if (cursor === null) throw new Error("expected a resume cursor");
  return cursor;
}

function grantMarkdown(db: ReturnType<typeof openLedger>, source: string, operation: string): void {
  registerConnection(db, MARKDOWN_FOLDER_CONNECTOR_ID, source);
  setSourceGrant(db, {
    source_key: source,
    expected_revision: 0,
    operation_id: operation,
    policy: {
      purposes: ["capture", "recall", "derive"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "private",
    },
  });
}

test("Core completes changing deletion pages before reporting malformed Markdown", async () => {
  const selected = await syntheticDir("kizuki-markdown-changing-pages-");
  const db = openLedger(":memory:"), source = "01JJ0000000000000000000001";
  try {
    for (const name of ["a", "b", "m", "z"]) {
      await writeFile(path.join(selected, `${name}.md`), `Synthetic ${name}\n`);
    }
    grantMarkdown(db, source, "synthetic-markdown-changing-pages");
    const connector = createMarkdownFolderConnector({ path: selected, page_size: 1 });
    const initial = await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill");
    expect(initial.stored).toBe(4); expect(initial.errors).toEqual([]);
    // Separate backfill/sync cursors: the snapshot lives on backfill_cursor.
    // Core's first sync is null; tombstones require this populated snapshot.
    expect(getCheckpoint(db, MARKDOWN_FOLDER_CONNECTOR_ID, source)).toMatchObject({
      backfill_cursor: initial.cursor,
      sync_cursor: null,
      backfill_complete: true,
    });
    await unlink(path.join(selected, "b.md")); await unlink(path.join(selected, "z.md"));
    await writeFile(path.join(selected, "m.md"), Buffer.from([255, 254, 253]));
    const originalBackfill = connector.backfill.bind(connector), batches: SyncBatch[] = [];
    connector.backfill = async cursor => {
      if (batches.length === 1) {
        expect(batches[0]!.events.map(event => event.source_record_id)).toEqual(["b.md"]);
        expect(JSON.parse(cursor!)).toMatchObject({ phase: "tombstones", after: "b.md", exhausted: false });
        await writeFile(path.join(selected, "z.md"), "Synthetic z\n");
        await unlink(path.join(selected, "a.md"));
      }
      const batch = await originalBackfill(cursor); batches.push(batch); return batch;
    };
    const changed = await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill");
    expect(changed.stored).toBe(2);
    expect(changed.errors).toEqual(["partial_import: 1 record errors (not_utf8=1)"]);
    expect(batches.map(batch => batch.events.map(event => [event.source_record_id, event.deleted]))).toEqual([
      [["b.md", true]], [["a.md", true]], [],
    ]);
    expect(batches.at(-1)).toMatchObject({ status: "unavailable", cursor: changed.cursor });
    const events = () => db.query<{ source_record_id: string; deleted: number }, []>(
      "SELECT source_record_id,deleted FROM events ORDER BY event_id",
    ).all();
    expect(events().filter(event => event.deleted)).toEqual([
      { source_record_id: "b.md", deleted: 1 }, { source_record_id: "a.md", deleted: 1 },
    ]);
    const beforeRepeat = events();
    connector.backfill = originalBackfill;
    const repeat = await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill");
    expect(repeat).toMatchObject({ stored: 0, duplicates: 0, cursor: changed.cursor, errors: changed.errors });
    expect(events()).toEqual(beforeRepeat);
    await writeFile(path.join(selected, "m.md"), "Synthetic repaired m\n");
    const repaired = await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill");
    expect(repaired).toMatchObject({ stored: 1, duplicates: 0, errors: [] });
    expect(events().at(-1)).toEqual({ source_record_id: "m.md", deleted: 0 });
    expect(await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill"))
      .toMatchObject({ stored: 0, duplicates: 0, errors: [] });
    expect(events()).toHaveLength(7);
  } finally { db.close(); }
});

test("file pages include new and edited identities below the previous watermark", async () => {
  const selected = await syntheticDir("kizuki-markdown-lower-keys-");
  await writeFile(path.join(selected, "m.md"), "Synthetic m before\n");
  await writeFile(path.join(selected, "z.md"), "Synthetic z\n");
  const connector = createMarkdownFolderConnector({ path: selected, page_size: 1 });
  const first = await connector.backfill(null);
  expect(idsOf(first.events)).toEqual(["m.md"]);
  expect(JSON.parse(first.cursor!)).toMatchObject({ phase: "files", after: "m.md", exhausted: false });
  await writeFile(path.join(selected, "a.md"), "Synthetic a new\n");
  await writeFile(path.join(selected, "m.md"), "Synthetic m edited\n");
  const second = await connector.backfill(first.cursor);
  expect(second.events.map(event => [event.source_record_id, event.text])).toEqual([["a.md", "Synthetic a new\n"]]);
  const third = await connector.backfill(second.cursor);
  expect(third.events.map(event => [event.source_record_id, event.text])).toEqual([["m.md", "Synthetic m edited\n"]]);
  const fourth = await connector.backfill(third.cursor);
  expect(idsOf(fourth.events)).toEqual(["z.md"]);
  expect((await connector.backfill(fourth.cursor)).events).toEqual([]);
});

test("selecting an independent folder captures only that folder's ordinary markdown", async () => {
  const parent = await syntheticDir("kizuki-fleet-markdown-select-");
  const selected = path.join(parent, "notes");
  await mkdir(path.join(selected, "nested"), { recursive: true });
  await mkdir(path.join(parent, "sibling"));
  await Promise.all([
    writeFile(path.join(parent, "outside.md"), "SYNTHETIC_OUTSIDE\n"),
    writeFile(path.join(parent, "sibling", "other.md"), "SYNTHETIC_SIBLING\n"),
    writeFile(path.join(selected, "alpha.md"), "SYNTHETIC_ALPHA\n"),
    writeFile(path.join(selected, "nested", "beta.md"), "SYNTHETIC_BETA\n"),
  ]);

  const first = await createMarkdownFolderConnector({ path: selected }).backfill(
    null,
  );
  expect(idsOf(first.events)).toEqual(["alpha.md", "nested/beta.md"]);
  const alpha = named(first.events, "alpha.md");
  const beta = named(first.events, "nested/beta.md");
  expect(alpha.text).toBe("SYNTHETIC_ALPHA\n");
  expect(beta.text).toBe("SYNTHETIC_BETA\n");
  for (const event of first.events) {
    expect(event).toEqual(
      expect.objectContaining({
        schema: "kizuki.event/v1",
        connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
        kind: "file",
        deleted: false,
      }),
    );
  }
  expect(alpha.subjects[0]?.subject_id).toMatch(/^markdown-folder:/);
  expect(beta.subjects[0]?.subject_id).toMatch(/^markdown-folder:/);
  expect(alpha.subjects[0]?.subject_id).not.toBe(beta.subjects[0]?.subject_id);

  const repeat = await createMarkdownFolderConnector({
    path: selected,
  }).backfill(null);
  expect(idsOf(repeat.events)).toEqual(["alpha.md", "nested/beta.md"]);
  expect(named(repeat.events, "alpha.md").subjects).toEqual(alpha.subjects);
  expect(named(repeat.events, "nested/beta.md").subjects).toEqual(beta.subjects);
});

test("resume reports one mixed ordinary-file lifecycle without repeating identities", async () => {
  const selected = await syntheticDir("kizuki-fleet-markdown-life-");
  await Promise.all([
    writeFile(path.join(selected, "kept.md"), "SYNTHETIC_KEPT\n"),
    writeFile(path.join(selected, "edited.md"), "SYNTHETIC_BEFORE\n"),
    writeFile(path.join(selected, "removed.md"), "SYNTHETIC_REMOVED\n"),
  ]);

  const first = await createMarkdownFolderConnector({ path: selected }).backfill(
    null,
  );
  expect(idsOf(first.events)).toEqual(["edited.md", "kept.md", "removed.md"]);
  const kept = named(first.events, "kept.md");
  const edited = named(first.events, "edited.md");
  const removed = named(first.events, "removed.md");

  const unchanged = await createMarkdownFolderConnector({
    path: selected,
  }).sync(requireCursor(first.cursor));
  expect(unchanged.events).toEqual([]);

  await writeFile(path.join(selected, "edited.md"), "SYNTHETIC_AFTER\n");
  await unlink(path.join(selected, "removed.md"));

  let mixed = await createMarkdownFolderConnector({ path: selected }).sync(
    requireCursor(unchanged.cursor),
  );
  const mixedEvents = [...mixed.events];
  for (let page = 0; mixed.events.length > 0 && page < 4; page += 1) {
    mixed = await createMarkdownFolderConnector({ path: selected }).sync(
      requireCursor(mixed.cursor),
    );
    mixedEvents.push(...mixed.events);
  }
  expect(mixed.events).toEqual([]);
  expect(idsOf(mixedEvents)).toEqual(["edited.md", "removed.md"]);

  const editedAgain = named(mixedEvents, "edited.md");
  expect(editedAgain.deleted).toBe(false);
  expect(editedAgain.text).toBe("SYNTHETIC_AFTER\n");
  expect(editedAgain.source_record_id).toBe(edited.source_record_id);
  expect(editedAgain.subjects).toEqual(edited.subjects);

  const tombstone = named(mixedEvents, "removed.md");
  expect(tombstone.deleted).toBe(true);
  expect(tombstone.text).toBe("");
  expect(tombstone.source_record_id).toBe(removed.source_record_id);
  expect(tombstone.subjects).toEqual(removed.subjects);

  const again = await createMarkdownFolderConnector({ path: selected }).sync(
    requireCursor(mixed.cursor),
  );
  expect(again.events).toEqual([]);

  const fresh = await createMarkdownFolderConnector({
    path: selected,
  }).backfill(null);
  expect(idsOf(fresh.events)).toEqual(["edited.md", "kept.md"]);
  expect(fresh.events.some((event) => event.deleted)).toBe(false);
  expect(named(fresh.events, "kept.md").subjects).toEqual(kept.subjects);
  expect(named(fresh.events, "kept.md").text).toBe("SYNTHETIC_KEPT\n");
  expect(named(fresh.events, "edited.md").subjects).toEqual(edited.subjects);
  expect(named(fresh.events, "edited.md").text).toBe("SYNTHETIC_AFTER\n");
});

test("ordinary files with identical text keep distinct stable identities", async () => {
  const selected = await syntheticDir("kizuki-fleet-markdown-twins-");
  await Promise.all([
    writeFile(path.join(selected, "twin-a.md"), "SYNTHETIC_SAME_TEXT\n"),
    writeFile(path.join(selected, "twin-b.md"), "SYNTHETIC_SAME_TEXT\n"),
  ]);

  const first = await createMarkdownFolderConnector({ path: selected }).backfill(
    null,
  );
  const left = named(first.events, "twin-a.md");
  const right = named(first.events, "twin-b.md");
  expect(left.text).toBe(right.text);
  expect(left.source_record_id).not.toBe(right.source_record_id);
  expect(left.subjects[0]?.subject_id).not.toBe(right.subjects[0]?.subject_id);

  const repeat = await createMarkdownFolderConnector({
    path: selected,
  }).backfill(null);
  expect(named(repeat.events, "twin-a.md").subjects).toEqual(left.subjects);
  expect(named(repeat.events, "twin-b.md").subjects).toEqual(right.subjects);

  const idle = await createMarkdownFolderConnector({ path: selected }).sync(
    requireCursor(first.cursor),
  );
  expect(idle.events).toEqual([]);
  expect(idle.has_more).toBe(false);
});

test("nested Unicode frontmatter notes round-trip through Core backfill", async () => {
  const selected = await syntheticDir("kizuki-markdown-unicode-");
  const db = openLedger(":memory:"), source = "01JJ0000000000000000000002";
  const nested = path.join(selected, "journal", "café");
  const body = [
    "---",
    "title: synthetic-frontmatter",
    "tags: [ada, café]",
    "---",
    "",
    "SYNTHETIC_UNICODE_BODY 日本語 🧬\n",
  ].join("\n");
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "note.md"), body);
    await writeFile(path.join(selected, "root.markdown"), "SYNTHETIC_MARKDOWN_EXT\n");
    grantMarkdown(db, source, "synthetic-markdown-unicode");
    const connector = createMarkdownFolderConnector({ path: selected });
    const first = await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill");
    expect(first).toMatchObject({ stored: 2, duplicates: 0, errors: [] });
    expect(getCheckpoint(db, MARKDOWN_FOLDER_CONNECTOR_ID, source)?.backfill_complete).toBe(true);
    const events = db.query<{ source_record_id: string; text: string }, []>(
      "SELECT source_record_id, text FROM events ORDER BY source_record_id",
    ).all();
    expect(events.map((event) => event.source_record_id)).toEqual([
      "journal/café/note.md",
      "root.markdown",
    ]);
    expect(events[0]?.text).toBe(body);
    expect(events[0]?.text).toContain("title: synthetic-frontmatter");
    expect(await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill"))
      .toMatchObject({ stored: 0, duplicates: 0, errors: [] });
    await writeFile(path.join(nested, "note.md"), `${body}edited\n`);
    expect(await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill"))
      .toMatchObject({ stored: 1, duplicates: 0, errors: [] });
    await unlink(path.join(nested, "note.md"));
    const removed = await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill");
    expect(removed).toMatchObject({ stored: 1, duplicates: 0, errors: [] });
    expect(db.query<{ deleted: number }, []>(
      "SELECT deleted FROM events WHERE source_record_id = 'journal/café/note.md' ORDER BY event_id DESC LIMIT 1",
    ).get()).toEqual({ deleted: 1 });
  } finally { db.close(); }
});

test("a bounded oversize note is isolated while its sibling still imports", async () => {
  const selected = await syntheticDir("kizuki-markdown-oversize-");
  const db = openLedger(":memory:"), source = "01JJ0000000000000000000003";
  try {
    await writeFile(path.join(selected, "kept.md"), "SYNTHETIC_KEPT_BOUNDED\n");
    await writeFile(path.join(selected, "huge.md"), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    grantMarkdown(db, source, "synthetic-markdown-oversize");
    const connector = createMarkdownFolderConnector({ path: selected });
    const first = await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill");
    expect(first.stored).toBe(1);
    expect(first.errors).toEqual(["partial_import: 1 record errors (too_large=1)"]);
    expect(db.query<{ source_record_id: string }, []>(
      "SELECT source_record_id FROM events",
    ).all()).toEqual([{ source_record_id: "kept.md" }]);
    await writeFile(path.join(selected, "huge.md"), "SYNTHETIC_REPAIRED_HUGE\n");
    const repaired = await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill");
    expect(repaired).toMatchObject({ stored: 1, duplicates: 0, errors: [] });
  } finally { db.close(); }
});

test("file pages stay inside the host sync batch byte bound", async () => {
  const selected = await syntheticDir("kizuki-markdown-batch-bytes-");
  const db = openLedger(":memory:"), source = "01JJ0000000000000000000005";
  const payload = "x".repeat(850_000);
  try {
    for (const name of ["a.md", "b.md", "c.md", "d.md", "e.md"]) {
      await writeFile(path.join(selected, name), payload);
    }
    grantMarkdown(db, source, "synthetic-markdown-batch-bytes");
    const connector = createMarkdownFolderConnector({ path: selected });
    const first = await connector.backfill(null);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.length).toBeLessThan(5);
    expect(first.has_more).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(first.events)).byteLength)
      .toBeLessThanOrEqual(MAX_SYNC_BATCH_BYTES);
    const drained = await runToCompletion(
      db,
      connector,
      MARKDOWN_FOLDER_CONNECTOR_ID,
      source,
      "backfill",
    );
    expect(drained.stored).toBe(5);
    expect(drained.errors).toEqual([]);
  } finally { db.close(); }
});

test("a many-file folder keeps a resume cursor inside Core's bound", async () => {
  const selected = await syntheticDir("kizuki-markdown-many-");
  const db = openLedger(":memory:"), source = "01JJ0000000000000000000004";
  try {
    await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        writeFile(path.join(selected, `n-${String(index).padStart(3, "0")}.md`), "n\n"),
      ),
    );
    grantMarkdown(db, source, "synthetic-markdown-many");
    const connector = createMarkdownFolderConnector({ path: selected });
    const first = await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill");
    expect(first.stored).toBe(120);
    expect(first.errors).toEqual([]);
    expect(utf8CursorBytes(first.cursor)).toBeLessThanOrEqual(MAX_CURSOR_BYTES);
    expect(await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill"))
      .toMatchObject({ stored: 0, duplicates: 0, errors: [] });
  } finally { db.close(); }
});

test("a snapshot that cannot fit the resume cursor fails closed", async () => {
  const selected = await syntheticDir("kizuki-markdown-cursor-limit-");
  await Promise.all(
    Array.from({ length: 200 }, () => {
      const name = `${crypto.randomUUID()}.md`;
      return writeFile(path.join(selected, name), `${name}\n`);
    }),
  );
  const connector = createMarkdownFolderConnector({ path: selected });
  const batch = await connector.backfill(null);
  expect(batch.events).toEqual([]);
  expect(batch).toMatchObject({
    status: "unavailable",
    cursor: null,
  });
  expect(batch.detail).toContain("cursor_limit");
});

test("tombstones require a snapshot cursor, not a null sync", async () => {
  const selected = await syntheticDir("kizuki-markdown-null-sync-");
  await writeFile(path.join(selected, "kept.md"), "SYNTHETIC_KEPT\n");
  await writeFile(path.join(selected, "removed.md"), "SYNTHETIC_REMOVED\n");
  const connector = createMarkdownFolderConnector({ path: selected });
  const first = await connector.backfill(null);
  await unlink(path.join(selected, "removed.md"));
  const orphan = await connector.sync(null);
  expect(orphan.events.some((event) => event.deleted)).toBe(false);
  expect(idsOf(orphan.events)).toEqual(["kept.md"]);
  const resumed = await connector.sync(requireCursor(first.cursor));
  expect(resumed.events.map((event) => [event.source_record_id, event.deleted])).toEqual([
    ["removed.md", true],
  ]);
});

test("a symlink inside the folder is skipped without capturing its target", async () => {
  const parent = await syntheticDir("kizuki-markdown-symlink-");
  const selected = path.join(parent, "notes");
  const outside = path.join(parent, "outside.md");
  await mkdir(selected);
  await writeFile(outside, "SYNTHETIC_OUTSIDE_TARGET\n");
  await writeFile(path.join(selected, "own.md"), "SYNTHETIC_OWN\n");
  await symlink(outside, path.join(selected, "link.md"));
  const connector = createMarkdownFolderConnector({ path: selected });
  const first = await connector.backfill(null);
  expect(idsOf(first.events)).toEqual(["own.md"]);
  expect(first.events[0]?.text).toBe("SYNTHETIC_OWN\n");
  expect(first.has_more).toBe(true);
  const terminal = await connector.backfill(requireCursor(first.cursor));
  expect(terminal).toEqual({
    events: [],
    cursor: first.cursor,
    status: "unavailable",
    detail: "partial_import: 1 record errors (symlink=1)",
  });
});

function utf8CursorBytes(cursor: string | null): number {
  if (cursor === null) throw new Error("expected a resume cursor");
  return new TextEncoder().encode(cursor).byteLength;
}

function hostMarkdown(
  db: ReturnType<typeof openLedger>,
  source: string,
  path: string,
  page_size?: number,
) {
  return createMarkdownFolderConnector(
    { path, ...(page_size === undefined ? {} : { page_size }) },
    { committedFiles: () => markdownCommittedIdentities(db, source) },
  );
}

describe("1500 unique host-backed files", () => {
  let selected: string;
  let db: ReturnType<typeof openLedger>;
  let connector: ReturnType<typeof hostMarkdown>;
  let first: Awaited<ReturnType<typeof runToCompletion>>;
  const source = "01JJ0000000000000000000015";

  beforeAll(async () => {
    // This source belongs to the suite, independent of per-test temporary roots.
    selected = await mkdtemp(path.join(os.tmpdir(), "kizuki-markdown-scale-1500-"));
    db = openLedger(":memory:");
    await Promise.all(
      Array.from({ length: 1500 }, (_, index) => {
        const name = `u-${String(index).padStart(4, "0")}.md`;
        return writeFile(path.join(selected, name), `unique-${index}\n`);
      }),
    );
    grantMarkdown(db, source, "synthetic-markdown-scale-1500");
    connector = hostMarkdown(db, source, selected, 1000);
    first = await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill");
  });

  afterAll(async () => {
    db?.close();
    if (selected !== undefined) await rm(selected, { recursive: true, force: true });
  });

  test("capture fits the compact Core cursor bound", () => {
    expect(first.stored).toBe(1500);
    expect(first.errors).toEqual([]);
    expect(utf8CursorBytes(first.cursor)).toBeLessThanOrEqual(MAX_CURSOR_BYTES);
    expect(JSON.parse(first.cursor ?? "")).toMatchObject({ committed_identities: true });
    expect(JSON.parse(first.cursor ?? "")).not.toHaveProperty("files");
    expect(JSON.parse(first.cursor ?? "")).not.toHaveProperty("pack");
  });

  test("repeating the capture emits no duplicates", async () => {
    expect(await runToCompletion(db, connector, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill"))
      .toMatchObject({ stored: 0, duplicates: 0, errors: [] });
  });

  test("a fresh connector resumes without duplicates", async () => {
    const restarted = hostMarkdown(db, source, selected, 1000);
    expect(await runToCompletion(db, restarted, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill"))
      .toMatchObject({ stored: 0, duplicates: 0, errors: [] });
  });
});

test("fresh host-backed connectors drain edits and deletes from committed identities", async () => {
  const selected = await syntheticDir("kizuki-markdown-restart-edit-");
  const db = openLedger(":memory:"), source = "01JJ0000000000000000000016";
  try {
    await writeFile(path.join(selected, "kept.md"), "kept\n");
    await writeFile(path.join(selected, "edited.md"), "before\n");
    await writeFile(path.join(selected, "removed.md"), "removed\n");
    grantMarkdown(db, source, "synthetic-markdown-restart-edit");
    expect(await runToCompletion(
      db, hostMarkdown(db, source, selected), MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill",
    )).toMatchObject({ stored: 3, duplicates: 0, errors: [] });
    await writeFile(path.join(selected, "edited.md"), "after\n");
    await unlink(path.join(selected, "removed.md"));
    const restarted = hostMarkdown(db, source, selected);
    const changed = await runToCompletion(db, restarted, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill");
    expect(changed).toMatchObject({ stored: 2, duplicates: 0, errors: [] });
    expect(db.query<{ source_record_id: string; deleted: number }, []>(
      "SELECT source_record_id, deleted FROM events ORDER BY event_id",
    ).all().filter((event) => event.deleted)).toEqual([
      { source_record_id: "removed.md", deleted: 1 },
    ]);
    expect(await runToCompletion(db, hostMarkdown(db, source, selected), MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill"))
      .toMatchObject({ stored: 0, duplicates: 0, errors: [] });
  } finally { db.close(); }
});

test("source-scoped committed identities do not contaminate an identical relpath on another source", async () => {
  const parent = await syntheticDir("kizuki-markdown-isolation-");
  const leftDir = path.join(parent, "a");
  const rightDir = path.join(parent, "b");
  const db = openLedger(":memory:");
  const left = "01JJ0000000000000000000017";
  const right = "01JJ0000000000000000000018";
  try {
    await mkdir(leftDir);
    await mkdir(rightDir);
    await writeFile(path.join(leftDir, "note.md"), "left-body\n");
    await writeFile(path.join(rightDir, "note.md"), "right-body\n");
    grantMarkdown(db, left, "synthetic-markdown-isolation-a");
    grantMarkdown(db, right, "synthetic-markdown-isolation-b");
    expect(await runToCompletion(
      db, hostMarkdown(db, left, leftDir), MARKDOWN_FOLDER_CONNECTOR_ID, left, "backfill",
    )).toMatchObject({ stored: 1, errors: [] });
    expect(await runToCompletion(
      db, hostMarkdown(db, right, rightDir), MARKDOWN_FOLDER_CONNECTOR_ID, right, "backfill",
    )).toMatchObject({ stored: 1, errors: [] });
    await unlink(path.join(leftDir, "note.md"));
    expect(await runToCompletion(
      db, hostMarkdown(db, left, leftDir), MARKDOWN_FOLDER_CONNECTOR_ID, left, "backfill",
    )).toMatchObject({ stored: 1, duplicates: 0, errors: [] });
    expect(markdownCommittedIdentities(db, left)).toEqual([]);
    expect(markdownCommittedIdentities(db, right)).toEqual([
      ["note.md", {
        sha256: new Bun.CryptoHasher("sha256").update(Buffer.from("right-body\n")).digest("hex"),
        size: Buffer.byteLength("right-body\n"),
      }],
    ]);
    expect(await runToCompletion(
      db, hostMarkdown(db, right, rightDir), MARKDOWN_FOLDER_CONNECTOR_ID, right, "backfill",
    )).toMatchObject({ stored: 0, duplicates: 0, errors: [] });
    expect(db.query<{ source_record_id: string; deleted: number; text: string }, [string]>(
      `SELECT e.source_record_id, e.deleted, e.text FROM events e
       JOIN source_event_bindings b ON b.event_id = e.event_id
       WHERE b.source_key = ? ORDER BY e.event_id`,
    ).all(right)).toEqual([
      { source_record_id: "note.md", deleted: 0, text: "right-body\n" },
    ]);
  } finally { db.close(); }
});

test("a crash after the Core event transaction before checkpoint keeps events and proposals", async () => {
  const selected = await syntheticDir("kizuki-markdown-crash-checkpoint-");
  const db = openLedger(":memory:"), source = "01JJ0000000000000000000019";
  try {
    await writeFile(path.join(selected, "kept.md"), "kept\n");
    grantMarkdown(db, source, "synthetic-markdown-crash-checkpoint");
    expect(await runToCompletion(
      db, hostMarkdown(db, source, selected), MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill",
    )).toMatchObject({ stored: 1, errors: [] });
    const before = getCheckpoint(db, MARKDOWN_FOLDER_CONNECTOR_ID, source);
    await writeFile(path.join(selected, "added.md"), "added\n");
    const live = hostMarkdown(db, source, selected);
    const batch = await live.backfill(before?.backfill_cursor ?? null);
    expect(batch.events.map((event) => event.source_record_id)).toEqual(["added.md"]);
    const processed = runBatch(
      db,
      batch,
      { page_candidates: false },
      sourceCaptureAdmission(db, MARKDOWN_FOLDER_CONNECTOR_ID, source) ?? undefined,
    );
    expect(processed.stored).toBe(1);
    expect(processed.proposals_created).toBeGreaterThan(0);
    expect(getCheckpoint(db, MARKDOWN_FOLDER_CONNECTOR_ID, source)?.backfill_cursor)
      .toBe(before?.backfill_cursor);
    const events = db.query<{ event_id: string; source_record_id: string }, []>(
      "SELECT event_id, source_record_id FROM events ORDER BY event_id",
    ).all();
    const proposals = db.query<{ proposal_id: string }, []>(
      "SELECT proposal_id FROM proposals ORDER BY proposal_id",
    ).all();
    expect(events.map((event) => event.source_record_id).sort()).toEqual(["added.md", "kept.md"]);
    const restarted = hostMarkdown(db, source, selected);
    expect(await runToCompletion(db, restarted, MARKDOWN_FOLDER_CONNECTOR_ID, source, "backfill"))
      .toMatchObject({ stored: 0, duplicates: 0, errors: [] });
    expect(db.query<{ event_id: string; source_record_id: string }, []>(
      "SELECT event_id, source_record_id FROM events ORDER BY event_id",
    ).all()).toEqual(events);
    expect(db.query<{ proposal_id: string }, []>(
      "SELECT proposal_id FROM proposals ORDER BY proposal_id",
    ).all()).toEqual(proposals);
  } finally { db.close(); }
});

test("files that appear between host-backed pages are still emitted", async () => {
  const selected = await syntheticDir("kizuki-markdown-compact-lower-keys-");
  const db = openLedger(":memory:"), source = "01JJ0000000000000000000020";
  try {
    await writeFile(path.join(selected, "m.md"), "Synthetic m before\n");
    await writeFile(path.join(selected, "z.md"), "Synthetic z\n");
    grantMarkdown(db, source, "synthetic-markdown-compact-lower-keys");
    const connector = hostMarkdown(db, source, selected, 1);
    const first = await connector.backfill(null);
    expect(idsOf(first.events)).toEqual(["m.md"]);
    expect(JSON.parse(first.cursor!)).toMatchObject({
      committed_identities: true,
      phase: "files",
      after: "m.md",
      exhausted: false,
    });
    const admitted = runBatch(
      db,
      first,
      { page_candidates: false },
      sourceCaptureAdmission(db, MARKDOWN_FOLDER_CONNECTOR_ID, source) ?? undefined,
    );
    expect(admitted.stored).toBe(1);
    await writeFile(path.join(selected, "a.md"), "Synthetic a new\n");
    await writeFile(path.join(selected, "m.md"), "Synthetic m edited\n");
    const second = await connector.backfill(first.cursor);
    expect(second.events.map((event) => [event.source_record_id, event.text])).toEqual([
      ["a.md", "Synthetic a new\n"],
    ]);
  } finally { db.close(); }
});
