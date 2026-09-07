import { describe, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
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
import { MAX_DEPTH, MAX_SCAN_ENTRIES } from "../src/markdown-folder";

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
          subjects: [expect.objectContaining({subject_id:expect.stringMatching(/^markdown-folder:[a-f0-9]{64}$/),role:"about"})],
          deleted: false,
          attachments: [],
          metadata: expect.objectContaining({
            relpath: "alpha.md",
            size: Buffer.byteLength("# Alpha\n"),
          }),
        }),
        expect.objectContaining({
          schema: "kizuki.event/v1",
          connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
          source_record_id: "nested/beta.md",
          kind: "file",
          text: "βeta\n",
          subjects: [expect.objectContaining({subject_id:expect.stringMatching(/^markdown-folder:[a-f0-9]{64}$/),role:"about"})],
          deleted: false,
          attachments: [],
          metadata: expect.objectContaining({
            relpath: "nested/beta.md",
            size: Buffer.byteLength("βeta\n"),
          }),
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
        subjects: initial.events[0]!.subjects,
        deleted: true,
        attachments: [],
        metadata: { relpath: "removed.md", snapshot: "absent" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("same-mtime changed bytes are still emitted", async () => {
    const root = await makeTempDir();
    try {
      const file = path.join(root, "note.md");
      await writeFile(file, "before\n");
      const stamp = new Date("2026-01-01T00:00:00Z");
      await utimes(file, stamp, stamp);
      const connector = createMarkdownFolderConnector({ path: root });
      const first = await connector.backfill(null);
      await writeFile(file, "after\n");
      await utimes(file, stamp, stamp);
      const second = await connector.sync(first.cursor);
      expect(second.events.map((event) => event.text)).toEqual(["after\n"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a cursor from another root is rejected", async () => {
    const firstRoot = await makeTempDir();
    const secondRoot = await makeTempDir();
    try {
      await writeFile(path.join(firstRoot, "a.md"), "a\n");
      await writeFile(path.join(secondRoot, "a.md"), "a\n");
      const first = await createMarkdownFolderConnector({
        path: firstRoot,
      }).backfill(null);
      try {
        await createMarkdownFolderConnector({ path: secondRoot }).sync(
          first.cursor,
        );
        throw new Error("expected a foreign cursor to be rejected");
      } catch (error) {
        expect(String(error)).toContain("does not belong to this root");
      }
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  test("a __proto__.md file is tracked as data, not a prototype key", async () => {
    const root = await makeTempDir();
    try {
      await writeFile(path.join(root, "__proto__.md"), "hostile\n");
      await writeFile(path.join(root, "ok.md"), "fine\n");
      const connector = createMarkdownFolderConnector({ path: root });
      const batch = await connector.backfill(null);
      expect(batch.events.map((event) => event.source_record_id).sort()).toEqual(
        ["__proto__.md", "ok.md"],
      );
      const cursor = JSON.parse(batch.cursor ?? "{}") as {
        files: Array<[string, { sha256: string }]>;
      };
      expect(cursor.files.map(([relpath]) => relpath).sort()).toEqual([
        "__proto__.md",
        "ok.md",
      ]);
      expect(Object.prototype).not.toHaveProperty("sha256");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("hidden and vendor directories are skipped", async () => {
    const root = await makeTempDir();
    try {
      await mkdir(path.join(root, ".git"));
      await mkdir(path.join(root, "node_modules"));
      await writeFile(path.join(root, ".hidden.md"), "no\n");
      await writeFile(path.join(root, ".git", "readme.md"), "git\n");
      await writeFile(path.join(root, "node_modules", "pkg.md"), "dep\n");
      await writeFile(path.join(root, "kept.md"), "yes\n");
      const batch = await createMarkdownFolderConnector({ path: root }).backfill(
        null,
      );
      expect(batch.events.map((event) => event.source_record_id)).toEqual([
        "kept.md",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("invalid UTF-8 is isolated and not accepted as replacement text", async () => {
    const root = await makeTempDir();
    try {
      await writeFile(path.join(root, "good.md"), "ok\n");
      await writeFile(path.join(root, "bad.md"), Buffer.from([0xff, 0xfe, 0x00]));
      const connector = createMarkdownFolderConnector({ path: root });
      const batch = await connector.backfill(null);
      expect(batch.events.map((event) => event.source_record_id)).toEqual([
        "good.md",
      ]);
      const health = await connector.health();
      expect(health.state).toBe("degraded");
      expect(health.detail ?? "").toContain("not_utf8");
      const terminal = await connector.backfill(batch.cursor);
      expect(terminal).toEqual({ events: [], cursor: batch.cursor, status: "unavailable",
        detail: "partial_import: 1 record errors (not_utf8=1)" });
      expect(await connector.backfill(batch.cursor)).toEqual(terminal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("malformed files preserve prior identity while valid and deleted pages drain before refusal", async () => {
    const root = await makeTempDir();
    try {
      await writeFile(path.join(root, "a-removed.md"), "removed later\n");
      await writeFile(path.join(root, "z-private-name.md"), "PRIVATE_SAVED_BODY\n");
      const connector = createMarkdownFolderConnector({ path: root, page_size: 1 });
      const first = await connector.backfill(null);
      const second = await connector.backfill(first.cursor);
      const before = await connector.backfill(second.cursor);
      expect(before.events).toEqual([]);
      await unlink(path.join(root, "a-removed.md"));
      await writeFile(path.join(root, "z-private-name.md"), Buffer.from([255, 254, 253]));
      await writeFile(path.join(root, "b-new.md"), "new B\n");
      await writeFile(path.join(root, "c-new.md"), "new C\n");
      const b = await connector.sync(before.cursor);
      const c = await connector.sync(b.cursor);
      const removed = await connector.sync(c.cursor);
      expect([b, c, removed].map(batch => batch.events.map(event => [event.source_record_id, event.deleted])))
        .toEqual([[["b-new.md", false]], [["c-new.md", false]], [["a-removed.md", true]]]);
      const terminal = await connector.sync(removed.cursor);
      expect(terminal).toEqual({ events: [], cursor: removed.cursor, status: "unavailable",
        detail: "partial_import: 1 record errors (not_utf8=1)" });
      expect(JSON.parse(terminal.cursor!).files.map(([name]: [string]) => name))
        .toEqual(["b-new.md", "c-new.md", "z-private-name.md"]);
      expect(await connector.sync(terminal.cursor)).toEqual(terminal);
      expect(terminal.detail).not.toContain("z-private-name");
      expect(terminal.detail).not.toContain("PRIVATE_SAVED_BODY");
      await writeFile(path.join(root, "z-private-name.md"), "repaired once\n");
      const repaired = await connector.sync(terminal.cursor);
      expect(repaired.events.map(event => [event.source_record_id, event.text, event.deleted]))
        .toEqual([["z-private-name.md", "repaired once\n", false]]);
      const clean = await connector.sync(repaired.cursor);
      expect(clean.events).toEqual([]);
      expect(clean.status).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a tombstones-phase cursor still emits files that appeared later", async () => {
    const root = await makeTempDir();
    try {
      await writeFile(path.join(root, "kept.md"), "kept\n");
      const connector = createMarkdownFolderConnector({ path: root });
      const first = await connector.backfill(null);
      const stuck = JSON.parse(first.cursor ?? "{}") as {
        phase: string;
        exhausted: boolean;
        after: string | null;
      };
      stuck.phase = "tombstones";
      stuck.exhausted = false;
      stuck.after = "zzz.md";

      await writeFile(path.join(root, "later.md"), "later\n");
      const second = await connector.sync(JSON.stringify(stuck));
      expect(second.events.map((event) => event.source_record_id)).toEqual([
        "later.md",
      ]);
      expect(second.events[0]?.deleted).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("page-sized backfills exhaust explicitly", async () => {
    const root = await makeTempDir();
    try {
      await Promise.all(
        ["a.md", "b.md", "c.md", "d.md"].map((name) =>
          writeFile(path.join(root, name), `${name}\n`),
        ),
      );
      const connector = createMarkdownFolderConnector({
        path: root,
        page_size: 2,
      });
      const first = await connector.backfill(null);
      const firstCursor = JSON.parse(first.cursor ?? "{}") as {
        exhausted: boolean;
        phase: string;
      };
      expect(first.events).toHaveLength(2);
      expect(firstCursor.exhausted).toBe(false);

      const second = await connector.backfill(first.cursor);
      const secondCursor = JSON.parse(second.cursor ?? "{}") as {
        exhausted: boolean;
      };
      expect(second.events).toHaveLength(2);
      expect(secondCursor.exhausted).toBe(true);

      const third = await connector.backfill(second.cursor);
      expect(third.events).toEqual([]);
      expect(JSON.parse(third.cursor ?? "{}")).toMatchObject({ exhausted: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an empty root returns an exhausted cursor", async () => {
    const root = await makeTempDir();
    try {
      const batch = await createMarkdownFolderConnector({ path: root }).backfill(
        null,
      );
      expect(batch.events).toEqual([]);
      expect(JSON.parse(batch.cursor ?? "{}")).toMatchObject({
        exhausted: true,
        files: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a bounded truncated scan refuses completion and preserves unseen prior identities", async () => {
    const root = await makeTempDir();
    let listing: ReturnType<typeof spyOn> | undefined;
    try {
      await writeFile(path.join(root, "prior.md"), "previous evidence\n");
      const connector = createMarkdownFolderConnector({ path: root });
      const first = await connector.backfill(null);
      const original = filesystem.readdir;
      const [entry] = await original(root, { withFileTypes: true });
      // Isolate the directory-listing boundary; no hundred-thousand-file fixture.
      const crowded = Array.from({ length: MAX_SCAN_ENTRIES + 1 }, (_, index) => ({ ...entry!, name: `.hidden-${index}` }));
      listing = spyOn(filesystem, "readdir").mockImplementation(((...args: Parameters<typeof original>) =>
        String(args[0]) === root ? Promise.resolve(crowded) : original(...args)) as typeof original);
      const result = await connector.sync(first.cursor);
      expect(result).toEqual({ events: [], cursor: first.cursor, status: "unavailable",
        detail: "partial_import: 1 record errors (scan_limit=1); scan truncated" });
      expect(await connector.sync(first.cursor)).toEqual(result);
      listing.mockRestore(); listing = undefined;
      expect((await connector.sync(first.cursor)).events).toEqual([]);
    } finally {
      listing?.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unreadable directory does not tombstone the files it hid", async () => {
    const root = await makeTempDir();
    const nested = path.join(root, "nested");
    try {
      await mkdir(nested);
      await writeFile(path.join(root, "kept.md"), "kept\n");
      await writeFile(path.join(nested, "hidden.md"), "hidden\n");
      const connector = createMarkdownFolderConnector({ path: root });
      const first = await connector.backfill(null);
      expect(first.events.map((event) => event.source_record_id).sort()).toEqual(
        ["kept.md", "nested/hidden.md"],
      );
      await chmod(nested, 0);
      try {
        const second = await connector.sync(first.cursor);
        expect(second.events.some((event) => event.deleted)).toBe(false);
        expect(
          second.events.map((event) => event.source_record_id),
        ).not.toContain("nested/hidden.md");
        expect(second).toEqual({ events: [], cursor: first.cursor, status: "unavailable",
          detail: "partial_import: 1 record errors (unreadable=1)" });
      } finally {
        await chmod(nested, 0o755);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a symlinked root still sweeps the resolved folder", async () => {
    const parent = await makeTempDir();
    try {
      const real = path.join(parent, "real");
      const link = path.join(parent, "link");
      await mkdir(real);
      await writeFile(path.join(real, "note.md"), "via link\n");
      await symlink(real, link);
      const batch = await createMarkdownFolderConnector({ path: link }).backfill(
        null,
      );
      expect(batch.events.map((event) => event.source_record_id)).toEqual([
        "note.md",
      ]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("a too-deep directory does not skip sibling files", async () => {
    const root = await makeTempDir();
    try {
      const segments = Array.from({ length: MAX_DEPTH + 1 }, (_, i) => `d${i}`);
      const buriedDir = path.join(root, ...segments);
      const limitDir = path.join(root, ...segments.slice(0, MAX_DEPTH));
      await mkdir(buriedDir, { recursive: true });
      await writeFile(path.join(buriedDir, "buried.md"), "too deep\n");
      await writeFile(path.join(limitDir, "at-limit.md"), "in bound\n");
      await writeFile(path.join(root, "zzz.md"), "sibling\n");
      const connector = createMarkdownFolderConnector({ path: root });
      const batch = await connector.backfill(null);
      expect(batch.events.map((event) => event.source_record_id).sort()).toEqual(
        [`${segments.slice(0, MAX_DEPTH).join("/")}/at-limit.md`, "zzz.md"],
      );
      const health = await connector.health();
      expect(health.state).toBe("degraded");
      expect(health.detail ?? "").toContain("depth");
      expect(await connector.backfill(batch.cursor)).toEqual({ events: [], cursor: batch.cursor, status: "unavailable",
        detail: "partial_import: 1 record errors (depth=1)" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unreadable file does not abort the rest of the scan", async () => {
    const root = await makeTempDir();
    try {
      await writeFile(path.join(root, "ok.md"), "ok\n");
      await mkdir(path.join(root, "blocked.md"));
      const batch = await createMarkdownFolderConnector({ path: root }).backfill(
        null,
      );
      expect(batch.events.map((event) => event.source_record_id)).toEqual([
        "ok.md",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("document subjects survive edits and tombstones without collapsing distinct paths", async () => {
  const root = await makeTempDir();
  try {
    await writeFile(path.join(root, "same-name.md"), "first");
    await writeFile(path.join(root, "same_name.md"), "second");
    const connector = createMarkdownFolderConnector({ path: root });
    const initial = await connector.backfill(null);
    const first = initial.events.find(event => event.source_record_id === "same-name.md")!;
    const second = initial.events.find(event => event.source_record_id === "same_name.md")!;
    expect(first.subjects).toHaveLength(1);
    expect(first.subjects[0]?.subject_id).not.toBe(second.subjects[0]?.subject_id);
    await writeFile(path.join(root, "same-name.md"), "changed contents");
    const edited = await connector.sync(initial.cursor);
    expect(edited.events.find(event => event.source_record_id === "same-name.md")?.subjects).toEqual(first.subjects);
    await unlink(path.join(root, "same-name.md"));
    const removed = await connector.sync(edited.cursor);
    expect(removed.events.find(event => event.source_record_id === "same-name.md" && event.deleted)?.subjects).toEqual(first.subjects);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
