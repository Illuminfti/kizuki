import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MARKDOWN_FOLDER_CONNECTOR_ID,
  createMarkdownFolderConnector,
} from "../src";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "kizuki-markdown-"));
}

describe("MarkdownFolderConnector", () => {
  test("backfills markdown files with per-file fields and relative ids", async () => {
    const root = await makeTempDir();
    try {
      await mkdir(path.join(root, "nested"));
      await Promise.all([
        writeFile(path.join(root, "alpha.md"), "# Alpha\n"),
        writeFile(path.join(root, "nested", "beta.md"), "βeta\n"),
        writeFile(path.join(root, "ignored.txt"), "not markdown"),
      ]);

      const batch = await createMarkdownFolderConnector({ path: root }).backfill(
        null,
      );

      expect(batch.cursor).not.toBeNull();
      expect(batch.events).toHaveLength(2);
      expect(batch.events.map((event) => event.source_record_id)).toEqual([
        "alpha.md",
        "nested/beta.md",
      ]);
      expect(batch.events).toEqual([
        expect.objectContaining({
          schema: "kizuki.event/v1",
          connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
          source_record_id: "alpha.md",
          kind: "file",
          text: "# Alpha\n",
          subjects: [],
          deleted: false,
          attachments: [],
          metadata: { relpath: "alpha.md", size: Buffer.byteLength("# Alpha\n") },
        }),
        expect.objectContaining({
          schema: "kizuki.event/v1",
          connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
          source_record_id: "nested/beta.md",
          kind: "file",
          text: "βeta\n",
          subjects: [],
          deleted: false,
          attachments: [],
          metadata: {
            relpath: "nested/beta.md",
            size: Buffer.byteLength("βeta\n"),
          },
        }),
      ]);
      for (const event of batch.events) {
        expect(Date.parse(event.occurred_at)).not.toBeNaN();
        expect(Date.parse(event.observed_at)).not.toBeNaN();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sync emits changed and new files only", async () => {
    const root = await makeTempDir();
    try {
      const changedPath = path.join(root, "changed.md");
      const unchangedPath = path.join(root, "unchanged.md");
      await Promise.all([
        writeFile(changedPath, "before\n"),
        writeFile(unchangedPath, "same\n"),
      ]);
      await Promise.all([
        utimes(changedPath, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z")),
        utimes(unchangedPath, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z")),
      ]);

      const connector = createMarkdownFolderConnector({ path: root });
      const initial = await connector.backfill(null);
      if (initial.cursor === null) throw new Error("expected a snapshot cursor");

      const newPath = path.join(root, "new.md");
      await Promise.all([
        writeFile(changedPath, "after\n"),
        writeFile(newPath, "new\n"),
      ]);
      await utimes(
        changedPath,
        new Date("2026-01-02T00:00:00Z"),
        new Date("2026-01-02T00:00:00Z"),
      );

      const batch = await connector.sync(initial.cursor);

      expect(batch.events.map((event) => event.source_record_id)).toEqual([
        "changed.md",
        "new.md",
      ]);
      expect(batch.events.map((event) => event.text)).toEqual([
        "after\n",
        "new\n",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sync emits a tombstone for a removed snapshot file", async () => {
    const root = await makeTempDir();
    try {
      const removedPath = path.join(root, "removed.md");
      await writeFile(removedPath, "gone soon\n");
      const connector = createMarkdownFolderConnector({ path: root });
      const initial = await connector.backfill(null);
      if (initial.cursor === null) throw new Error("expected a snapshot cursor");

      await unlink(removedPath);
      const batch = await connector.sync(initial.cursor);

      expect(batch.events).toHaveLength(1);
      const tombstone = batch.events[0];
      if (tombstone === undefined) throw new Error("expected a tombstone event");
      expect(tombstone).toEqual({
        schema: "kizuki.event/v1",
        connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
        source_record_id: "removed.md",
        kind: "file",
        occurred_at: tombstone.observed_at,
        observed_at: tombstone.observed_at,
        text: "",
        subjects: [],
        deleted: true,
        attachments: [],
        metadata: { relpath: "removed.md" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
