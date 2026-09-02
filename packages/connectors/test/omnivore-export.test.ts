import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KizukiError } from "../src/errors";
import { FIXTURE_OBSERVED_AT, MAX_RECORD_BYTES } from "../src/util";
import {
  OMNIVORE_FIXTURE_FILES,
  createOmnivoreImportConnector,
  fsOmnivoreFiles,
  mapOmnivoreFiles,
  omnivoreEvents,
} from "../src/import-omnivore";
import type { OmnivoreImportConfig } from "../src/import-omnivore";

async function withTempRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-omnivore-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function thrown(body: () => unknown): KizukiError {
  try {
    body();
  } catch (error) {
    if (error instanceof KizukiError) return error;
    throw error;
  }
  throw new Error("expected a KizukiError");
}

async function rejected(body: () => Promise<unknown>): Promise<KizukiError> {
  try {
    await body();
  } catch (error) {
    if (error instanceof KizukiError) return error;
    throw error;
  }
  throw new Error("expected a KizukiError");
}

async function writeExport(
  dir: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function metadataFile(items: unknown[]): Record<string, string> {
  return { "metadata_0_to_9.json": JSON.stringify(items) };
}

test("the byte budget is spent across the whole export, not per file", async () => {
  await withTempRoot(async (root) => {
    const items = (id: string): unknown[] => [
      { id, slug: id, savedAt: "2026-01-01T09:00:00Z" },
    ];
    await writeExport(root, {
      "metadata_0_to_9.json": JSON.stringify(items("one")),
      "metadata_10_to_19.json": JSON.stringify(items("two")),
    });
    const first = JSON.stringify(items("one")).length;
    expect((await fsOmnivoreFiles(root, first * 2)).metadata.length).toBe(2);
    const error = await rejected(() => fsOmnivoreFiles(root, first + 1));
    expect(error.code).toBe("misconfigured");
    expect(error.message).toContain("import limit");
  });
});

test("the export budget is charged the bytes read, not the bytes kept", async () => {
  await withTempRoot(async (root) => {
    const pretty = (id: string): string =>
      JSON.stringify([{ id, slug: id, savedAt: "2026-01-01T09:00:00Z" }], null, 2)
        .replace(/\n/g, "\r\n");
    await writeExport(root, {
      "metadata_0_to_9.json": pretty("one"),
      "metadata_10_to_19.json": pretty("two"),
    });
    const raw = Buffer.byteLength(pretty("one"), "utf8");

    const error = await rejected(() => fsOmnivoreFiles(root, raw * 2 - 1));
    expect(error.code).toBe("misconfigured");
    expect(error.message).toContain("import limit");
    expect((await fsOmnivoreFiles(root, raw * 2)).metadata.length).toBe(2);
  });
});

test("one highlights file costs the export budget once, not once per item", async () => {
  await withTempRoot(async (root) => {
    const notes = `${"n".repeat(400)}\n`;
    const items = Array.from({ length: 20 }, (_, index) => ({
      id: `item-${index}`,
      slug: "shared",
      savedAt: "2026-01-01T09:00:00Z",
    }));
    await writeExport(root, {
      ...metadataFile(items),
      "highlights/shared.md": notes,
    });
    const metadataBytes = Buffer.byteLength(
      metadataFile(items)["metadata_0_to_9.json"] ?? "",
      "utf8",
    );
    const notesBytes = Buffer.byteLength(notes, "utf8");

    // Twenty items name one file: read once, it fits alongside the metadata.
    const events = await omnivoreEvents(
      await fsOmnivoreFiles(root, metadataBytes + notesBytes),
      FIXTURE_OBSERVED_AT,
    );
    expect(events.length).toBe(20);
    for (const event of events) {
      expect(event.metadata["has_highlights"]).toBe(true);
    }

    // A budget with no room left for it refuses rather than reading it free.
    const error = await rejected(async () =>
      omnivoreEvents(
        await fsOmnivoreFiles(root, metadataBytes),
        FIXTURE_OBSERVED_AT,
      ),
    );
    expect(error.code).toBe("misconfigured");
    expect(error.message).toContain("import limit");
  });
});

test("the assembled records are bounded, not just the files they came from", async () => {
  const notes = "n".repeat(2000);
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: `item-${index}`,
    slug: "shared",
    savedAt: "2026-01-01T09:00:00Z",
  }));
  const files = mapOmnivoreFiles({
    ...metadataFile(items),
    "highlights/shared.md": notes,
  });
  expect((await omnivoreEvents(files, FIXTURE_OBSERVED_AT)).length).toBe(20);
  const error = await rejected(() =>
    omnivoreEvents(files, FIXTURE_OBSERVED_AT, 5000),
  );
  expect(error.code).toBe("parse_error");
  expect(error.message).toBe("export holds more than 5000 bytes of item text");
});

test("a slug that is not a bare name reaches no file at all", async () => {
  await withTempRoot(async (root) => {
    const canary = "canary-quartz-heron";
    await writeFile(path.join(root, "canary.md"), canary);
    const exportDir = path.join(root, "export");
    await writeExport(exportDir, {
      ...metadataFile([
        { id: "1", slug: "../canary", savedAt: "2026-01-01T09:00:00Z" },
        { id: "2", slug: "a/b", savedAt: "2026-01-02T09:00:00Z" },
        { id: "3", slug: "linked", savedAt: "2026-01-03T09:00:00Z" },
      ]),
      "highlights/keep.md": "kept",
    });
    await symlink(
      path.join(root, "canary.md"),
      path.join(exportDir, "highlights", "linked.md"),
    );
    const events = await omnivoreEvents(
      await fsOmnivoreFiles(exportDir),
      FIXTURE_OBSERVED_AT,
    );
    expect(events.length).toBe(3);
    for (const event of events) {
      expect(event.text).not.toContain(canary);
      expect(event.metadata["has_highlights"]).toBe(false);
      expect(event.attachments).toEqual([]);
    }
  });
});

test("a symlinked highlights or content directory reaches nothing", async () => {
  await withTempRoot(async (root) => {
    const canary = "canary-quartz-heron";
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "linked.md"), canary);
    await writeFile(path.join(outside, "linked.html"), canary);
    const exportDir = path.join(root, "export");
    await writeExport(
      exportDir,
      metadataFile([
        { id: "1", slug: "linked", savedAt: "2026-01-01T09:00:00Z" },
      ]),
    );
    await symlink(outside, path.join(exportDir, "highlights"));
    await symlink(outside, path.join(exportDir, "content"));
    const events = await omnivoreEvents(
      await fsOmnivoreFiles(exportDir),
      FIXTURE_OBSERVED_AT,
    );
    expect(events.length).toBe(1);
    expect(events[0]?.text).not.toContain(canary);
    expect(events[0]?.metadata["has_highlights"]).toBe(false);
    expect(events[0]?.attachments).toEqual([]);
  });
});

test("a folder swapped for a link after the scan reaches nothing", async () => {
  await withTempRoot(async (root) => {
    // The scan reads directory entries, and an entry's type is a snapshot: a
    // real folder can become a link between being listed and being read.
    const canary = "canary-quartz-heron";
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "linked.md"), canary);
    await writeFile(path.join(outside, "linked.html"), canary);
    const exportDir = path.join(root, "export");
    await writeExport(
      exportDir,
      metadataFile([
        { id: "1", slug: "linked", savedAt: "2026-01-01T09:00:00Z" },
      ]),
    );
    await mkdir(path.join(exportDir, "highlights"));
    await mkdir(path.join(exportDir, "content"));

    const files = await fsOmnivoreFiles(exportDir);
    for (const name of ["highlights", "content"]) {
      await rm(path.join(exportDir, name), { recursive: true });
      await symlink(outside, path.join(exportDir, name));
    }
    expect(await files.highlight("linked")).toBe(null);
    expect(await files.content("linked")).toBe(null);

    const events = await omnivoreEvents(files, FIXTURE_OBSERVED_AT);
    expect(events[0]?.text).not.toContain(canary);
    expect(events[0]?.metadata["has_highlights"]).toBe(false);
    expect(events[0]?.attachments).toEqual([]);
  });
});

test("a highlights file that is present but unreadable refuses the import", async () => {
  await withTempRoot(async (root) => {
    // The slug comes from the item title, so it must never be quoted back.
    const slug = "my-quartz-heron-notes-2026";
    const exportDir = path.join(root, "export");
    await writeExport(exportDir, {
      ...metadataFile([{ id: "1", slug, savedAt: "2026-01-01T09:00:00Z" }]),
      "highlights/keep.md": "kept",
    });
    const file = path.join(exportDir, "highlights", `${slug}.md`);

    await writeFile(file, Buffer.from([0x41, 0xff, 0x42]));
    const invalid = await rejected(async () =>
      omnivoreEvents(await fsOmnivoreFiles(exportDir), FIXTURE_OBSERVED_AT),
    );
    expect(invalid.code).toBe("parse_error");
    expect(invalid.message).toContain("not valid UTF-8");
    expect(invalid.message).toContain("metadata_0_to_9.json item 1");
    expect(invalid.message).not.toContain(slug);

    await writeFile(file, "x".repeat(MAX_RECORD_BYTES + 1));
    const oversize = await rejected(async () =>
      omnivoreEvents(await fsOmnivoreFiles(exportDir), FIXTURE_OBSERVED_AT),
    );
    expect(oversize.code).toBe("misconfigured");
    expect(oversize.message).toContain("import limit");
    expect(oversize.message).toContain("metadata_0_to_9.json item 1");
    expect(oversize.message).not.toContain(slug);
  });
});

test("an export directory without metadata files is refused", async () => {
  await withTempRoot(async (root) => {
    const connector = createOmnivoreImportConnector({ path: root });
    const error = await rejected(() => connector.backfill(null));
    expect(error.code).toBe("misconfigured");
    expect(error.message).toContain("no metadata_*.json in");
    const report = await connector.health();
    expect(report.state).toBe("misconfigured");
    expect(report.detail).toContain(root);
  });
});

test("a zip path is refused with an actionable message", async () => {
  const connector = createOmnivoreImportConnector({
    path: "/exports/omni.zip",
  });
  const error = await rejected(() => connector.backfill(null));
  expect(error.code).toBe("misconfigured");
  expect(error.message).toContain("unzip the export first");
});

test("an unzipped export reads from disk exactly as from memory", async () => {
  await withTempRoot(async (root) => {
    await writeExport(root, OMNIVORE_FIXTURE_FILES);
    const connector = createOmnivoreImportConnector({ path: root });
    expect((await connector.health()).state).toBe("ok");
    const batch = await connector.backfill(null);
    const fixture = await connector.fixture();
    expect(batch.cursor).toBeNull();
    expect(
      batch.events.map((event) => ({ ...event, observed_at: "" })),
    ).toEqual(fixture.map((event) => ({ ...event, observed_at: "" })));
    expect(await connector.purgeSource("omnivore:self")).toEqual({
      subject_id: "omnivore:self",
      source_record_ids: [],
      unreachable_source_record_ids: [
        "a1b2c3d4-0000-4000-8000-000000000001",
        "a1b2c3d4-0000-4000-8000-000000000002",
        "a1b2c3d4-0000-4000-8000-000000000003",
      ],
    });
  });
});

test("an export directory that cannot be listed is refused, not thrown", async () => {
  await withTempRoot(async (root) => {
    const locked = path.join(root, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const connector = createOmnivoreImportConnector({ path: locked });
      const error = await rejected(() => connector.backfill(null));
      expect(error.code).toBe("misconfigured");
      expect(error.message).toContain("cannot read");
      const report = await connector.health();
      expect(report.state).toBe("misconfigured");
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

test("a malformed config fails construction", () => {
  const construct = (config: unknown): void => {
    createOmnivoreImportConnector(config as OmnivoreImportConfig);
  };
  expect(() => construct({ path: "/x" })).not.toThrow();
  for (const config of [{}, { path: "/x", slug: "x" }]) {
    expect(thrown(() => construct(config)).code).toBe("misconfigured");
  }
});

test("health proves the export opens without reading all of it", async () => {
  await withTempRoot(async (root) => {
    const exportDir = path.join(root, "export");
    await writeExport(
      exportDir,
      metadataFile([{ id: "1", slug: "one", savedAt: "2026-01-01T09:00:00Z" }]),
    );
    const connector = createOmnivoreImportConnector({ path: exportDir });
    expect((await connector.health()).state).toBe("ok");

    // An import reads every metadata part, and the command line asks for
    // health first, so a health check that read them too would read the whole
    // export twice. It opens the first part and looks at its opening bytes; a
    // fault past them belongs to the read that actually happens.
    const part = path.join(exportDir, "metadata_0_to_9.json");
    await writeFile(
      part,
      Buffer.concat([
        Buffer.from('[{"id":"1","slug":"one","savedAt":"'),
        Buffer.from([0xff]),
        Buffer.from('"}]'),
      ]),
    );
    expect((await connector.health()).state).toBe("ok");
    expect((await rejected(() => connector.backfill(null))).code).toBe(
      "parse_error",
    );

    // What the opening does prove: the part is readable and is the array of
    // items an export holds, rather than some other JSON.
    await writeFile(part, '{"items": []}');
    const report = await connector.health();
    expect(report.state).toBe("misconfigured");
    expect(report.detail).toContain("does not begin a JSON array");

    await chmod(part, 0o000);
    try {
      expect((await connector.health()).state).toBe("misconfigured");
    } finally {
      await chmod(part, 0o600);
    }
  });
});
