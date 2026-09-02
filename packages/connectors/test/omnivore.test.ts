import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateEventInput } from "@kizuki/core";
import { KizukiError } from "../src/errors";
import { FIXTURE_OBSERVED_AT } from "../src/util";
import {
  OMNIVORE_FIXTURE_FILES,
  OMNIVORE_IMPORT_CONNECTOR_ID,
  createOmnivoreImportConnector,
  fsOmnivoreFiles,
  mapOmnivoreFiles,
  omnivoreEvents,
  parseOmnivoreMetadata,
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

test("the fixture export maps to three bookmarks", async () => {
  const events = await createOmnivoreImportConnector({
    path: "/nonexistent",
  }).fixture();
  expect(events.map((event) => event.source_record_id)).toEqual([
    "a1b2c3d4-0000-4000-8000-000000000001",
    "a1b2c3d4-0000-4000-8000-000000000002",
    "a1b2c3d4-0000-4000-8000-000000000003",
  ]);
  expect(events.map((event) => event.occurred_at)).toEqual([
    "2026-01-01T09:00:00.000Z",
    "2026-01-02T08:00:00.000Z",
    "2026-01-03T09:00:00.000Z",
  ]);
  expect(events[0]?.text).toBe(
    [
      "Local-first software",
      "https://example.com/local-first-software",
      "Why data should live on the owner's disk.",
      "## Highlights\n\n> Data stays under your control.\n\nNote: relevant for acme.",
    ].join("\n\n"),
  );
  expect(events[2]?.text).toBe(
    "Acme launch plan\n\nhttps://example.com/acme-launch-plan",
  );
  expect(events.map((event) => event.metadata["has_highlights"])).toEqual([
    true,
    false,
    false,
  ]);
  expect(events.map((event) => event.metadata["labels"])).toEqual([
    ["software", "reading"],
    ["birds"],
    [],
  ]);
  expect(events[0]?.attachments).toEqual([
    {
      attachment_id: "content",
      media_type: "text/html",
      filename: "content/local-first-software.html",
      byte_size: Buffer.byteLength(
        OMNIVORE_FIXTURE_FILES["content/local-first-software.html"] ?? "",
        "utf8",
      ),
    },
  ]);
  expect(events[1]?.attachments.length).toBe(1);
  expect(events[2]?.attachments).toEqual([]);
  for (const event of events) {
    expect(event.connector_id).toBe(OMNIVORE_IMPORT_CONNECTOR_ID);
    expect(event.kind).toBe("bookmark");
    expect(event.sensitivity_hint).toBe("personal");
    expect(event.deleted).toBe(false);
    expect(event.observed_at).toBe(FIXTURE_OBSERVED_AT);
    expect(event.subjects).toEqual([
      { subject_id: "omnivore:self", role: "from" },
    ]);
    expect(validateEventInput(event).ok).toBe(true);
  }
});

test("volatile fields never reach the stored metadata", async () => {
  const events = await createOmnivoreImportConnector({
    path: "/nonexistent",
  }).fixture();
  for (const event of events) {
    expect(Object.keys(event.metadata).sort()).toEqual([
      "author",
      "has_highlights",
      "labels",
      "published_at",
      "state",
      "title",
      "url",
    ]);
  }
});

test("metadata files are read in name order", async () => {
  const events = await omnivoreEvents(
    mapOmnivoreFiles({
      "metadata_10_to_19.json": JSON.stringify([
        { id: "second", slug: "second", savedAt: "2026-01-02T09:00:00Z" },
      ]),
      "metadata_0_to_9.json": JSON.stringify([
        { id: "first", slug: "first", savedAt: "2026-01-01T09:00:00Z" },
      ]),
      "notes.txt": "ignored",
    }),
    FIXTURE_OBSERVED_AT,
  );
  expect(events.map((event) => event.source_record_id)).toEqual([
    "first",
    "second",
  ]);
});

test("a duplicated id across files becomes a second record", async () => {
  const events = await omnivoreEvents(
    mapOmnivoreFiles({
      "metadata_0_to_9.json": JSON.stringify([
        { id: "same", slug: "one", savedAt: "2026-01-01T09:00:00Z" },
      ]),
      "metadata_10_to_19.json": JSON.stringify([
        { id: "same", slug: "two", savedAt: "2026-01-02T09:00:00Z" },
      ]),
    }),
    FIXTURE_OBSERVED_AT,
  );
  expect(events.map((event) => event.source_record_id)).toEqual([
    "same",
    "same#2",
  ]);
});

test("a malformed item names its file and index, never its title", () => {
  const title = "Quartz heron notes";
  for (const item of [
    { slug: "quartz-heron-notes", title, savedAt: "2026-01-01T09:00:00Z" },
    { id: "x", title, savedAt: "2026-01-01T09:00:00Z" },
    { id: "x", slug: "quartz-heron-notes", title, savedAt: "never" },
    { id: "x", slug: "quartz-heron-notes", title },
  ]) {
    const error = thrown(() =>
      parseOmnivoreMetadata(
        JSON.stringify([
          { id: "ok", slug: "ok", savedAt: "2026-01-01T09:00:00Z" },
          item,
        ]),
        "metadata_0_to_9.json",
      ),
    );
    expect(error.code).toBe("parse_error");
    expect(error.message).toContain("metadata_0_to_9.json[1]");
    expect(error.message).not.toContain("heron");
  }
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

test("a malformed config fails construction", () => {
  const construct = (config: unknown): void => {
    createOmnivoreImportConnector(config as OmnivoreImportConfig);
  };
  expect(() => construct({ path: "/x" })).not.toThrow();
  for (const config of [{}, { path: "/x", slug: "x" }]) {
    expect(thrown(() => construct(config)).code).toBe("misconfigured");
  }
});
