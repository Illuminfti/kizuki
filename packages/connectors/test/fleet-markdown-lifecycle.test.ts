import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MARKDOWN_FOLDER_CONNECTOR_ID,
  createMarkdownFolderConnector,
} from "../src";

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
});
