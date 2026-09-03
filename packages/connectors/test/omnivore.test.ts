import { expect, test } from "bun:test";
import { validateEventInput } from "@kizuki/core";
import { KizukiError } from "../src/errors";
import { FIXTURE_OBSERVED_AT, MAX_RECORD_BYTES } from "../src/util";
import {
  OMNIVORE_FIXTURE_FILES,
  OMNIVORE_IMPORT_CONNECTOR_ID,
  createOmnivoreImportConnector,
  mapOmnivoreFiles,
  omnivoreEvents,
  parseOmnivoreMetadata,
} from "../src/import-omnivore";

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

test("a doubled export keeps two records rather than collapsing them", async () => {
  const first = { id: "same", slug: "one", savedAt: "2026-01-01T09:00:00Z" };
  const second = { id: "same", slug: "two", savedAt: "2026-01-02T09:00:00Z" };
  const both = await omnivoreEvents(
    mapOmnivoreFiles({
      "metadata_0_to_9.json": JSON.stringify([first]),
      "metadata_10_to_19.json": JSON.stringify([second]),
    }),
    FIXTURE_OBSERVED_AT,
  );
  expect(both.map((event) => event.source_record_id)).toEqual([
    "same",
    "same#2",
  ]);
});

test("an id that already ends in a number cannot claim another record", async () => {
  const events = await omnivoreEvents(
    mapOmnivoreFiles(
      metadataFile([
        { id: "same", slug: "one", savedAt: "2026-01-01T09:00:00Z" },
        { id: "same#2", slug: "two", savedAt: "2026-01-02T09:00:00Z" },
        { id: "same", slug: "three", savedAt: "2026-01-03T09:00:00Z" },
      ]),
    ),
    FIXTURE_OBSERVED_AT,
  );
  expect(events.map((event) => event.source_record_id)).toEqual([
    "same",
    "same#2",
    "same#3",
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

test("an oversize field names its position and never its value", () => {
  const huge = "h".repeat(MAX_RECORD_BYTES + 1);
  for (const [field, item] of [
    ["title", { id: "x", slug: "x", title: huge }],
    ["description", { id: "x", slug: "x", description: huge }],
    ["url", { id: "x", slug: "x", url: huge }],
    ["labels", { id: "x", slug: "x", labels: [huge] }],
  ] as const) {
    const error = thrown(() =>
      parseOmnivoreMetadata(
        JSON.stringify([{ ...item, savedAt: "2026-01-01T09:00:00Z" }]),
        "metadata_0_to_9.json",
      ),
    );
    expect(error.code).toBe("parse_error");
    expect(error.message).toContain(`metadata_0_to_9.json[0].${field}`);
    expect(error.message).not.toContain(huge);
  }
});

test("a labels list is bounded as a field, not label by label", () => {
  // Every label is small; there are simply too many of them for the record
  // budget, which bounding each of them on its own never noticed.
  const labels = Array.from({ length: 300_000 }, (_, index) => `l${index}`);
  const error = thrown(() =>
    parseOmnivoreMetadata(
      JSON.stringify([
        {
          id: "x",
          slug: "x",
          labels,
          savedAt: "2026-01-01T09:00:00Z",
        },
      ]),
      "metadata_0_to_9.json",
    ),
  );
  expect(error.code).toBe("parse_error");
  expect(error.message).toBe(
    `metadata_0_to_9.json[0].labels: exceeds ${MAX_RECORD_BYTES} bytes`,
  );
});

test("an assembled record beyond the bound names its item", async () => {
  const half = "h".repeat(MAX_RECORD_BYTES - 16);
  const error = await rejected(() =>
    omnivoreEvents(
      mapOmnivoreFiles(
        metadataFile([
          {
            id: "x",
            slug: "x",
            title: half,
            description: half,
            savedAt: "2026-01-01T09:00:00Z",
          },
        ]),
      ),
      FIXTURE_OBSERVED_AT,
    ),
  );
  expect(error.code).toBe("parse_error");
  expect(error.message).toContain("metadata_0_to_9.json item 1");
});
