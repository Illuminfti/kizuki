import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EVENT_LIMITS,
  MAX_CURSOR_BYTES,
  MAX_SYNC_BATCH_BYTES,
  MAX_SYNC_BATCH_EVENTS,
  getCheckpoint,
  registerConnection,
  replay,
  runBackfill,
  runToCompletion,
  setSourceGrant,
  validateEventInput,
} from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { KizukiError } from "../src/errors";
import { FIXTURE_OBSERVED_AT } from "../src/util";
import {
  POCKET_CURSOR_SCHEMA,
  POCKET_IMPORT_CONNECTOR_ID,
  createPocketImportConnector,
  parsePocketCsv,
  pocketEvents,
} from "../src/import-pocket";

const HEADER = "title,url,time_added,tags,status";
const SOURCE_KEY = "01JJ0000000000000000000008";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function syntheticDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-pocket-life-"));
  roots.push(root);
  return root;
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

function csv(rows: readonly string[]): string {
  return `${HEADER}\n${rows.join("\n")}\n`;
}

function grantSource(db: ReturnType<typeof openLedger>): void {
  setSourceGrant(db, {
    source_key: SOURCE_KEY,
    expected_revision: 0,
    operation_id: "synthetic-pocket-grant",
    policy: {
      purposes: ["capture", "recall", "derive"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "public",
    },
  });
}

function record(event: CaptureEventInput | undefined) {
  return {
    source_record_id: event?.source_record_id,
    occurred_at: event?.occurred_at,
    text: event?.text,
    title: event?.metadata["title"],
    url: event?.metadata["url"],
    tags: event?.metadata["tags"],
    status: event?.metadata["status"],
    deleted: event?.deleted,
  };
}

test("unread, archive, and deleted status stay live bookmarks with the cell as evidence", () => {
  const events = pocketEvents(
    parsePocketCsv(
      csv([
        "Saved item,https://example.com/saved,1767225600,software|reading,unread",
        "Archived item,https://example.com/archived,1767312000,,archive",
        "Deleted item,https://example.com/deleted,1767398400,notes,deleted",
      ]),
      "part.csv",
    ),
    FIXTURE_OBSERVED_AT,
  );
  expect(events.map(record)).toEqual([
    {
      source_record_id: "https://example.com/saved",
      occurred_at: "2026-01-01T00:00:00.000Z",
      text: "Saved item\nhttps://example.com/saved",
      title: "Saved item",
      url: "https://example.com/saved",
      tags: ["software", "reading"],
      status: "unread",
      deleted: false,
    },
    {
      source_record_id: "https://example.com/archived",
      occurred_at: "2026-01-02T00:00:00.000Z",
      text: "Archived item\nhttps://example.com/archived",
      title: "Archived item",
      url: "https://example.com/archived",
      tags: [],
      status: "archive",
      deleted: false,
    },
    {
      source_record_id: "https://example.com/deleted",
      occurred_at: "2026-01-03T00:00:00.000Z",
      text: "Deleted item\nhttps://example.com/deleted",
      title: "Deleted item",
      url: "https://example.com/deleted",
      tags: ["notes"],
      status: "deleted",
      deleted: false,
    },
  ]);
  for (const event of events) {
    expect(event.connector_id).toBe(POCKET_IMPORT_CONNECTOR_ID);
    expect(event.kind).toBe("bookmark");
    expect(event.sensitivity_hint).toBe("personal");
    expect(event.subjects).toEqual([
      { subject_id: "pocket:self", role: "from" },
    ]);
    expect(validateEventInput(event).ok).toBe(true);
  }
});

test("quoted titles, empty titles, and the url itself keep independent wording", () => {
  const events = pocketEvents(
    parsePocketCsv(
      csv([
        '"Local-first software, explained",https://example.com/local-first,1767225600,software,unread',
        '"A ""quoted"" title",https://example.com/quoted,1767312000,,unread',
        ",https://example.com/untitled,1767398400,,archive",
      ]),
      "part.csv",
    ),
    FIXTURE_OBSERVED_AT,
  );
  expect(events.map((event) => event.text)).toEqual([
    "Local-first software, explained\nhttps://example.com/local-first",
    'A "quoted" title\nhttps://example.com/quoted',
    "https://example.com/untitled",
  ]);
  expect(events.map((event) => event.metadata["url"])).toEqual([
    "https://example.com/local-first",
    "https://example.com/quoted",
    "https://example.com/untitled",
  ]);
});

test("an unreadable timestamp is refused at the row and never rewritten", () => {
  const title = "Quartz heron field notes";
  for (const time of ["", "not-a-time", "0", "-1", "1767225600.5"]) {
    const error = thrown(() =>
      parsePocketCsv(
        csv([`${title},https://example.com/a,${time},,unread`]),
        "part.csv",
      ),
    );
    expect(error.code).toBe("parse_error");
    expect(error.message).toBe("part.csv row 2: invalid unix timestamp");
    expect(error.message).not.toContain("heron");
  }
});

test("a title or tag list the ledger cannot store is refused without quoting it", () => {
  const hugeTitle = "T".repeat(EVENT_LIMITS.metadataStringBytes + 1);
  const titleError = thrown(() =>
    pocketEvents(
      [
        {
          title: hugeTitle,
          url: "https://example.com/huge",
          time_added: "1767225600",
          tags: [],
          status: "unread",
        },
      ],
      FIXTURE_OBSERVED_AT,
    ),
  );
  expect(titleError.code).toBe("parse_error");
  expect(titleError.message).toContain("row 1");
  expect(titleError.message).toContain(
    `exceeds ${EVENT_LIMITS.metadataStringBytes} UTF-8 bytes`,
  );
  expect(titleError.message).not.toContain(hugeTitle);

  const tagError = thrown(() =>
    pocketEvents(
      [
        {
          title: "Synthetic",
          url: "https://example.com/tags",
          time_added: "1767225600",
          tags: Array.from(
            { length: EVENT_LIMITS.metadataArrayLength + 1 },
            (_, index) => `t${index}`,
          ),
          status: "unread",
        },
      ],
      FIXTURE_OBSERVED_AT,
    ),
  );
  expect(tagError.code).toBe("parse_error");
  expect(tagError.message).toContain("row 1");
  expect(tagError.message).toContain(
    `exceeds max array length ${EVENT_LIMITS.metadataArrayLength}`,
  );
});

test("a snapshot larger than one ingest batch resumes from the durable checkpoint", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "pocket.csv");
  const count = MAX_SYNC_BATCH_EVENTS + 1;
  const rows = Array.from({ length: count }, (_, index) => {
    if (index === MAX_SYNC_BATCH_EVENTS - 1 || index === MAX_SYNC_BATCH_EVENTS) {
      return `Twin,https://example.com/twin,${1767225600 + index},,unread`;
    }
    return `Item ${index},https://example.com/${index},${1767225600 + index},,unread`;
  });
  await writeFile(file, csv(rows));
  const connector = createPocketImportConnector({ path: file });
  const expected = pocketEvents(
    parsePocketCsv(csv(rows), "part.csv"),
    FIXTURE_OBSERVED_AT,
  );
  expect(expected.map((event) => event.source_record_id).slice(-2)).toEqual([
    "https://example.com/twin",
    "https://example.com/twin#2",
  ]);

  const first = await connector.backfill(null);
  expect(first.events).toHaveLength(MAX_SYNC_BATCH_EVENTS);
  expect(first.cursor).not.toBeNull();
  expect(
    new TextEncoder().encode(first.cursor ?? "").byteLength,
  ).toBeLessThanOrEqual(MAX_CURSOR_BYTES);
  const checkpoint = JSON.parse(first.cursor ?? "") as {
    schema: string;
    after: number;
  };
  expect(checkpoint.schema).toBe(POCKET_CURSOR_SCHEMA);
  expect(checkpoint.after).toBe(MAX_SYNC_BATCH_EVENTS);
  expect(first.events.map((event) => event.source_record_id)).toEqual(
    expected.slice(0, MAX_SYNC_BATCH_EVENTS).map((event) => event.source_record_id),
  );

  const second = await connector.backfill(first.cursor);
  expect(second.events).toHaveLength(1);
  expect(second.cursor).toBeNull();
  expect(second.events[0]?.source_record_id).toBe("https://example.com/twin#2");

  const db = openLedger(":memory:");
  try {
    registerConnection(db, POCKET_IMPORT_CONNECTOR_ID, SOURCE_KEY);
    grantSource(db);
    const stored = await runToCompletion(
      db,
      connector,
      POCKET_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
    );
    expect(stored).toMatchObject({
      stored: count,
      duplicates: 0,
      errors: [],
      cursor: null,
    });
    expect(getCheckpoint(db, POCKET_IMPORT_CONNECTOR_ID, SOURCE_KEY)?.cursor).toBeNull();
    expect(
      [...replay(db, {})].map((event) => event.source_record_id),
    ).toEqual(expected.map((event) => event.source_record_id));

    const repeat = await runToCompletion(
      db,
      connector,
      POCKET_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
    );
    expect(repeat).toMatchObject({
      stored: 0,
      duplicates: count,
      errors: [],
      cursor: null,
    });
  } finally {
    db.close();
  }
});

test("a malformed page after a checkpoint keeps the earlier page and resumes", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "pocket.csv");
  const count = MAX_SYNC_BATCH_EVENTS + 1;
  const valid = csv(
    Array.from(
      { length: count },
      (_, index) =>
        `Item ${index},https://example.com/${index},${1767225600 + index},,unread`,
    ),
  );
  await writeFile(file, valid);
  const connector = createPocketImportConnector({ path: file });
  const db = openLedger(":memory:");
  try {
    registerConnection(db, POCKET_IMPORT_CONNECTOR_ID, SOURCE_KEY);
    grantSource(db);
    const first = await runBackfill(
      db,
      connector,
      POCKET_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
    );
    expect(first.stored).toBe(MAX_SYNC_BATCH_EVENTS);
    expect(first.errors).toEqual([]);
    const cursor = first.cursor;
    expect(cursor).not.toBeNull();

    await writeFile(file, csv(["Broken,https://example.com/x,not-a-time,,unread"]));
    const failed = await runBackfill(
      db,
      connector,
      POCKET_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
    );
    expect(failed.stored).toBe(0);
    expect(failed.errors).toEqual([
      expect.stringContaining("invalid unix timestamp"),
    ]);
    expect(getCheckpoint(db, POCKET_IMPORT_CONNECTOR_ID, SOURCE_KEY)?.cursor).toBe(
      cursor,
    );

    await writeFile(file, valid);
    const finished = await runToCompletion(
      db,
      connector,
      POCKET_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
    );
    expect(finished).toMatchObject({
      stored: 1,
      duplicates: 0,
      errors: [],
      cursor: null,
    });
    expect([...replay(db, {})]).toHaveLength(count);
  } finally {
    db.close();
  }
});

test("replacing the export after a checkpoint restarts from the first row", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "pocket.csv");
  const count = MAX_SYNC_BATCH_EVENTS + 1;
  await writeFile(
    file,
    csv(
      Array.from(
        { length: count },
        (_, index) =>
          `Old ${index},https://example.com/old/${index},${1767225600 + index},,unread`,
      ),
    ),
  );
  const connector = createPocketImportConnector({ path: file });
  const first = await connector.backfill(null);
  expect(first.events).toHaveLength(MAX_SYNC_BATCH_EVENTS);
  expect(first.cursor).not.toBeNull();

  await writeFile(
    file,
    csv(
      Array.from(
        { length: count },
        (_, index) =>
          `New ${index},https://example.com/new/${index},${1767225600 + index},,unread`,
      ),
    ),
  );
  const restarted = await connector.backfill(first.cursor);
  expect(restarted.events).toHaveLength(MAX_SYNC_BATCH_EVENTS);
  expect(restarted.events[0]?.source_record_id).toBe(
    "https://example.com/new/0",
  );
  expect(restarted.cursor).not.toBeNull();
});

test("a page stays inside the host byte budget", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "pocket.csv");
  const title = "N".repeat(20_000);
  const rows = Array.from(
    { length: 120 },
    (_, index) =>
      `${title},https://example.com/wide/${index},${1767225600 + index},,unread`,
  );
  await writeFile(file, csv(rows));
  const connector = createPocketImportConnector({ path: file });
  const all = pocketEvents(parsePocketCsv(csv(rows), "part.csv"), FIXTURE_OBSERVED_AT);
  expect(
    new TextEncoder().encode(JSON.stringify(all)).byteLength,
  ).toBeGreaterThan(MAX_SYNC_BATCH_BYTES);

  const first = await connector.backfill(null);
  expect(first.cursor).not.toBeNull();
  expect(first.events.length).toBeGreaterThan(0);
  expect(first.events.length).toBeLessThan(all.length);
  expect(
    new TextEncoder().encode(JSON.stringify(first.events)).byteLength,
  ).toBeLessThanOrEqual(MAX_SYNC_BATCH_BYTES);
});

test("a corrupt checkpoint is refused", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "pocket.csv");
  await writeFile(
    file,
    csv(["Synthetic,https://example.com/a,1767225600,,unread"]),
  );
  const connector = createPocketImportConnector({ path: file });
  const error = await rejected(() => connector.backfill("\u0000not-a-cursor"));
  expect(error.code).toBe("parse_error");
  expect(error.message).toBe(`${POCKET_IMPORT_CONNECTOR_ID}: malformed cursor`);
});

test("purge plans every bookmark as unreachable and leaves the export", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "pocket.csv");
  const body = csv([
    "Saved,https://example.com/saved,1767225600,,unread",
    "Archived,https://example.com/archived,1767312000,,archive",
    "Deleted,https://example.com/deleted,1767398400,,deleted",
  ]);
  await writeFile(file, body);
  const connector = createPocketImportConnector({ path: file });
  expect(await connector.purgeSource("pocket:self")).toEqual({
    complete: true,
    subject_id: "pocket:self",
    source_record_ids: [],
    unreachable_source_record_ids: [
      "https://example.com/archived",
      "https://example.com/deleted",
      "https://example.com/saved",
    ],
  });
  expect(await readFile(file, "utf8")).toBe(body);
});
