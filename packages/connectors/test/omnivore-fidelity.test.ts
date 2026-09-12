import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_SYNC_BATCH_EVENTS,
  getCheckpoint,
  registerConnection,
  replay,
  runToCompletion,
  setSourceGrant,
  validateEventInput,
  type CaptureEvent,
  type CaptureEventInput,
} from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { KizukiError } from "../src/errors";
import { FIXTURE_OBSERVED_AT } from "../src/util";
import {
  OMNIVORE_CURSOR_SCHEMA,
  OMNIVORE_IMPORT_CONNECTOR_ID,
  createOmnivoreImportConnector,
  mapOmnivoreFiles,
  omnivoreEvents,
  pageOmnivoreEvents,
} from "../src/import-omnivore";

/** The old ambiguous encoding lets one highlight impersonate two records. */
function delimiterJoinedFingerprint(events: readonly CaptureEventInput[]): string {
  return events.map((event) => [
    event.source_record_id,
    event.occurred_at,
    event.text,
    JSON.stringify(event.metadata),
    event.attachments.map((attachment) =>
      `${attachment.attachment_id}:${attachment.byte_size ?? 0}`,
    ).join(","),
  ].join("\n")).join("\n\n");
}

const SOURCE_KEY = "01JJ0000000000000000000004";
const HTML_SENTINEL = "SYNTHETIC_HTML_BODY";
const NOTE = "a synthetic owner note";
const QUOTE = "A synthetic quoted passage.";

async function withTempRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-omnivore-fid-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

function grant(db: ReturnType<typeof openLedger>): void {
  setSourceGrant(db, {
    source_key: SOURCE_KEY,
    expected_revision: 0,
    operation_id: "synthetic-omnivore-fidelity",
    policy: {
      purposes: ["capture", "recall", "derive"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "public",
    },
  });
}

function stored(db: ReturnType<typeof openLedger>): CaptureEvent[] {
  return [...replay(db, {})];
}

function items(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    slug: `item-${index}`,
    title: `Title ${index}`,
    savedAt: "2026-01-01T09:00:00Z",
  }));
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

test("article text, highlights, notes, labels and native ids survive together", async () => {
  const events = await omnivoreEvents(
    mapOmnivoreFiles({
      ...metadataFile([
        {
          id: "article-1",
          slug: "synthetic-article",
          title: "Synthetic article title",
          description: "Synthetic article description",
          author: "ada",
          url: "https://example.test/synthetic-article",
          state: "Active",
          labels: [
            "software",
            { name: "reading" },
            "",
            { name: "" },
            12,
            { color: "red" },
          ],
          savedAt: "2026-03-04T15:06:07Z",
          publishedAt: "2026-02-01T00:00:00Z",
        },
      ]),
      "highlights/synthetic-article.md":
        `## Highlights\n\n> ${QUOTE}\n\nNote: ${NOTE}\n`,
      "content/synthetic-article.html": `<html><body><p>${HTML_SENTINEL}</p></body></html>`,
    }),
    FIXTURE_OBSERVED_AT,
  );
  expect(events).toHaveLength(1);
  const event = events[0]!;
  expect(event.source_record_id).toBe("article-1");
  expect(event.occurred_at).toBe("2026-03-04T15:06:07.000Z");
  expect(event.text).toBe(
    [
      "Synthetic article title",
      "https://example.test/synthetic-article",
      "Synthetic article description",
      `## Highlights\n\n> ${QUOTE}\n\nNote: ${NOTE}`,
    ].join("\n\n"),
  );
  expect(event.text).toContain(QUOTE);
  expect(event.text).toContain(NOTE);
  expect(event.text).not.toContain(HTML_SENTINEL);
  expect(event.metadata["labels"]).toEqual(["software", "reading"]);
  expect(event.metadata["author"]).toBe("ada");
  expect(event.metadata["published_at"]).toBe("2026-02-01T00:00:00.000Z");
  expect(event.metadata["has_highlights"]).toBe(true);
  expect(event.deleted).toBe(false);
  expect(event.attachments).toEqual([
    {
      attachment_id: "content",
      media_type: "text/html",
      filename: "content/synthetic-article.html",
      byte_size: Buffer.byteLength(
        `<html><body><p>${HTML_SENTINEL}</p></body></html>`,
        "utf8",
      ),
    },
  ]);
  expect(validateEventInput(event).ok).toBe(true);
});

test("an explicit Deleted state is evidence in metadata, not a tombstone", async () => {
  const events = await omnivoreEvents(
    mapOmnivoreFiles(
      metadataFile([
        {
          id: "gone",
          slug: "gone",
          state: "Deleted",
          savedAt: "2026-01-01T09:00:00Z",
        },
      ]),
    ),
    FIXTURE_OBSERVED_AT,
  );
  expect(events[0]?.deleted).toBe(false);
  expect(events[0]?.metadata["state"]).toBe("Deleted");
});

test("a snapshot larger than one ingest batch resumes without dropping records", async () => {
  const events = await omnivoreEvents(
    mapOmnivoreFiles(metadataFile(items(MAX_SYNC_BATCH_EVENTS + 1))),
    FIXTURE_OBSERVED_AT,
  );
  const first = pageOmnivoreEvents(events, null);
  expect(first.events).toHaveLength(MAX_SYNC_BATCH_EVENTS);
  expect(first.cursor).not.toBeNull();
  const second = pageOmnivoreEvents(events, first.cursor);
  expect(second.events.map((event) => event.source_record_id)).toEqual([
    `item-${MAX_SYNC_BATCH_EVENTS}`,
  ]);
  expect(second.cursor).toBeNull();
  expect(pageOmnivoreEvents(events, null).cursor).not.toBeNull();
});

test("a byte-bounded page stops before the host would refuse the batch", async () => {
  const events = await omnivoreEvents(
    mapOmnivoreFiles(metadataFile(items(3))),
    FIXTURE_OBSERVED_AT,
  );
  const twoBytes = Buffer.byteLength(
    JSON.stringify([events[0], events[1]]),
    "utf8",
  );
  const first = pageOmnivoreEvents(events, null, { maxBytes: twoBytes });
  expect(first.events.map((event) => event.source_record_id)).toEqual([
    "item-0",
    "item-1",
  ]);
  expect(first.cursor).not.toBeNull();
  const rest = pageOmnivoreEvents(events, first.cursor, { maxBytes: twoBytes });
  expect(rest.events.map((event) => event.source_record_id)).toEqual(["item-2"]);
  expect(rest.cursor).toBeNull();
});

test("a changed export restarts instead of skipping later records", async () => {
  const original = await omnivoreEvents(
    mapOmnivoreFiles(metadataFile(items(4))),
    FIXTURE_OBSERVED_AT,
  );
  const paused = pageOmnivoreEvents(original, null, { maxEvents: 2 });
  expect(paused.cursor).not.toBeNull();
  const changed = await omnivoreEvents(
    mapOmnivoreFiles(
      metadataFile([
        { id: "new-a", slug: "new-a", savedAt: "2026-01-01T09:00:00Z" },
        { id: "new-b", slug: "new-b", savedAt: "2026-01-02T09:00:00Z" },
        { id: "new-c", slug: "new-c", savedAt: "2026-01-03T09:00:00Z" },
      ]),
    ),
    FIXTURE_OBSERVED_AT,
  );
  const resumed = pageOmnivoreEvents(changed, paused.cursor, { maxEvents: 2 });
  expect(resumed.events.map((event) => event.source_record_id)).toEqual([
    "new-a",
    "new-b",
  ]);
});

test("a delimiter-colliding one-row highlight restarts a paused page at record a", async () => {
  const original = await omnivoreEvents(
    mapOmnivoreFiles({
      ...metadataFile([
        { id: "a", slug: "a", savedAt: "2026-01-01T09:00:00Z" },
        { id: "b", slug: "b", savedAt: "2026-01-02T09:00:00Z" },
      ]),
      "highlights/a.md": "note-a",
      "highlights/b.md": "note-b",
    }),
    FIXTURE_OBSERVED_AT,
  );
  const paused = pageOmnivoreEvents(original, null, { maxEvents: 1 });
  expect(paused.events.map((event) => event.source_record_id)).toEqual(["a"]);
  expect(paused.cursor).not.toBeNull();
  expect(JSON.parse(paused.cursor ?? "")).toMatchObject({
    schema: OMNIVORE_CURSOR_SCHEMA,
    connector_id: OMNIVORE_IMPORT_CONNECTOR_ID,
    after: 1,
  });

  const first = original[0]!;
  const second = original[1]!;
  const collidingHighlight = [
    [
      first.text,
      JSON.stringify(first.metadata),
      first.attachments
        .map(
          (attachment) =>
            `${attachment.attachment_id}:${attachment.byte_size ?? 0}`,
        )
        .join(","),
    ].join("\n"),
    [second.source_record_id, second.occurred_at, second.text].join("\n"),
  ].join("\n\n");
  const changed = await omnivoreEvents(
    mapOmnivoreFiles({
      ...metadataFile([
        { id: "a", slug: "a", savedAt: "2026-01-01T09:00:00Z" },
      ]),
      "highlights/a.md": collidingHighlight,
    }),
    FIXTURE_OBSERVED_AT,
  );
  expect(changed.map((event) => event.source_record_id)).toEqual(["a"]);
  expect(delimiterJoinedFingerprint(changed)).toBe(
    delimiterJoinedFingerprint(original),
  );

  const resumed = pageOmnivoreEvents(changed, paused.cursor, { maxEvents: 1 });
  expect(resumed.events.map((event) => event.source_record_id)).toEqual(["a"]);
  expect(resumed.events[0]?.text).toBe(collidingHighlight);
  expect(resumed.cursor).toBeNull();
});

test("a corrupt resume cursor is refused rather than treated as the start", async () => {
  await withTempRoot(async (root) => {
    await writeExport(root, metadataFile(items(1)));
    const connector = createOmnivoreImportConnector({ path: root });
    const error = await rejected(() => connector.backfill("\u0000not-a-cursor"));
    expect(error.code).toBe("parse_error");
    expect(error.message).toContain("resume cursor");
  });
});

test("Core can interrupt and restart a paged import without tombstones or loss", async () => {
  await withTempRoot(async (root) => {
    await writeExport(root, metadataFile(items(MAX_SYNC_BATCH_EVENTS + 1)));
    const connector = createOmnivoreImportConnector({ path: root });
    const db = openLedger(":memory:");
    try {
      registerConnection(db, OMNIVORE_IMPORT_CONNECTOR_ID, SOURCE_KEY);
      grant(db);
      const first = await runToCompletion(
        db,
        connector,
        OMNIVORE_IMPORT_CONNECTOR_ID,
        SOURCE_KEY,
        "backfill",
        { maxBatches: 1 },
      );
      expect(first.stored).toBe(MAX_SYNC_BATCH_EVENTS);
      expect(first.errors).toEqual(["run did not complete within 1 batches"]);
      expect(getCheckpoint(db, OMNIVORE_IMPORT_CONNECTOR_ID, SOURCE_KEY)?.cursor).not.toBeNull();

      const rest = await runToCompletion(
        db,
        connector,
        OMNIVORE_IMPORT_CONNECTOR_ID,
        SOURCE_KEY,
        "backfill",
      );
      expect(rest.stored).toBe(1);
      expect(rest.errors).toEqual([]);
      expect(getCheckpoint(db, OMNIVORE_IMPORT_CONNECTOR_ID, SOURCE_KEY)?.cursor).toBeNull();
      expect(stored(db)).toHaveLength(MAX_SYNC_BATCH_EVENTS + 1);
      expect(stored(db).some((event) => event.deleted)).toBe(false);

      await writeExport(root, metadataFile(items(1)));
      const smaller = await runToCompletion(
        db,
        connector,
        OMNIVORE_IMPORT_CONNECTOR_ID,
        SOURCE_KEY,
        "sync",
      );
      expect(smaller).toMatchObject({
        stored: 0,
        duplicates: 1,
        withdrawn: 0,
        retractions_filed: 0,
        errors: [],
        cursor: null,
      });
      expect(stored(db)).toHaveLength(MAX_SYNC_BATCH_EVENTS + 1);
      expect(stored(db).some((event) => event.deleted)).toBe(false);
    } finally {
      db.close();
    }
  });
});
