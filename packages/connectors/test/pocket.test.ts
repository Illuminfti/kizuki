import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateEventInput } from "@kizuki/core";
import { KizukiError } from "../src/errors";
import { FIXTURE_OBSERVED_AT } from "../src/util";
import {
  POCKET_FIXTURE_EXPORT,
  POCKET_IMPORT_CONNECTOR_ID,
  createPocketImportConnector,
  parsePocketCsv,
  pocketEvents,
} from "../src/import-pocket";

const HEADER = "title,url,time_added,tags,status";

async function withTempRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-pocket-"));
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

test("the fixture export maps to four bookmarks", async () => {
  const events = await createPocketImportConnector({
    path: "/nonexistent",
  }).fixture();
  expect(events.map((event) => event.source_record_id)).toEqual([
    "https://example.com/local-first",
    "https://example.com/heron",
    "https://example.com/quoted",
    "https://example.com/heron#2",
  ]);
  expect(events[0]?.occurred_at).toBe("2026-01-01T00:00:00.000Z");
  expect(events[2]?.text).toBe('A "quoted" title\nhttps://example.com/quoted');
  expect(events[0]?.metadata["tags"]).toEqual(["software", "reading"]);
  expect(events[1]?.metadata["tags"]).toEqual([]);
  expect(events[1]?.metadata["status"]).toBe("archive");
  for (const event of events) {
    expect(event.connector_id).toBe(POCKET_IMPORT_CONNECTOR_ID);
    expect(event.kind).toBe("bookmark");
    expect(event.sensitivity_hint).toBe("personal");
    expect(event.deleted).toBe(false);
    expect(event.attachments).toEqual([]);
    expect(event.subjects).toEqual([
      { subject_id: "pocket:self", role: "from" },
    ]);
    expect(event.observed_at).toBe(FIXTURE_OBSERVED_AT);
    expect(validateEventInput(event).ok).toBe(true);
  }
});

test("a directory of parts is read in name order", async () => {
  await withTempRoot(async (root) => {
    await writeFile(
      path.join(root, "part_000001.csv"),
      `${HEADER}\nSecond,https://example.com/second,1767312000,,unread\n`,
    );
    await writeFile(
      path.join(root, "part_000000.csv"),
      `${HEADER}\nFirst,https://example.com/first,1767225600,,unread\n`,
    );
    const batch = await createPocketImportConnector({ path: root }).backfill(
      null,
    );
    expect(batch.cursor).toBeNull();
    expect(batch.events.map((event) => event.source_record_id)).toEqual([
      "https://example.com/first",
      "https://example.com/second",
    ]);
  });
});

test("the header decides the columns, not their order", () => {
  const rows = parsePocketCsv(
    "status,time_added,url,title\nunread,1767225600,https://example.com/a,A title\n",
    "part.csv",
  );
  expect(rows).toEqual([
    {
      title: "A title",
      url: "https://example.com/a",
      time_added: "1767225600",
      tags: [],
      status: "unread",
    },
  ]);
  // A row is the five fields the export has, and nothing derived beside them.
  expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
    "status",
    "tags",
    "time_added",
    "title",
    "url",
  ]);
});

test("a status cell is kept as the export wrote it", () => {
  // The cell is evidence of what the export said, so it is not tidied on the
  // way in: a reader comparing it against `archive` decides what to make of
  // the padding, and the record still says what was there.
  const rows = parsePocketCsv(
    `${HEADER}\nA,https://example.com/a,1767225600,,"  archive  "\n`,
    "part.csv",
  );
  expect(rows[0]?.status).toBe("  archive  ");
  expect(pocketEvents(rows, FIXTURE_OBSERVED_AT)[0]?.metadata["status"]).toBe(
    "  archive  ",
  );
});

test("tags are split on the pipe and trimmed", () => {
  const rows = parsePocketCsv(
    `${HEADER}\nA,https://example.com/a,1767225600, software | reading ||,unread\n`,
    "part.csv",
  );
  expect(rows[0]?.tags).toEqual(["software", "reading"]);
});

test("a blank line before the header does not hide the export", async () => {
  const text = `\n${POCKET_FIXTURE_EXPORT}`;
  expect(parsePocketCsv(text, "part_000000.csv").length).toBe(4);
  await withTempRoot(async (root) => {
    const file = path.join(root, "pocket.csv");
    await writeFile(file, text);
    const connector = createPocketImportConnector({ path: file });
    expect((await connector.health()).state).toBe("ok");
    expect((await connector.backfill(null)).events.length).toBe(4);
  });
});

test("a CSV without the required columns is not a Pocket export", () => {
  for (const text of [
    "title,tags,status\nA,b,unread\n",
    "<!DOCTYPE html>\n<html><head><title>Export</title></head>\n",
  ]) {
    const error = thrown(() => parsePocketCsv(text, "ril_export.html"));
    expect(error.code).toBe("parse_error");
    expect(error.message).toBe("ril_export.html: not a Pocket CSV export");
  }
});

test("a malformed row names its position and never its title", () => {
  const title = "Quartz heron field notes";
  for (const row of [
    `${title},,1767225600,,unread`,
    `${title},https://example.com/a,not-a-time,,unread`,
    `${title},https://example.com/a,1767225600,unread`,
  ]) {
    const error = thrown(() =>
      parsePocketCsv(`${HEADER}\n${row}\n`, "part.csv"),
    );
    expect(error.code).toBe("parse_error");
    expect(error.message).toContain("part.csv row 2");
    expect(error.message).not.toContain("heron");
  }
});

test("a blank line does not shift the line a refusal names", () => {
  const error = thrown(() =>
    parsePocketCsv(
      [
        HEADER,
        "A,https://example.com/a,1767225600,,unread",
        "",
        "B,https://example.com/b,notanumber,,unread",
        "",
      ].join("\n"),
      "part_000000.csv",
    ),
  );
  expect(error.code).toBe("parse_error");
  expect(error.message).toBe(
    "part_000000.csv row 4: invalid unix timestamp",
  );
});

test("the same url saved twice is two records, numbered in file order", () => {
  const rows = `${HEADER}\nA,https://example.com/a,1767225600,,unread\nA,https://example.com/a,1767312000,,archive\n`;
  const events = pocketEvents(
    parsePocketCsv(rows, "part.csv"),
    FIXTURE_OBSERVED_AT,
  );
  expect(events.map((event) => event.source_record_id)).toEqual([
    "https://example.com/a",
    "https://example.com/a#2",
  ]);
});

test("two saves of one url in the same second stay two records", () => {
  const events = pocketEvents(
    parsePocketCsv(
      [
        HEADER,
        "A,https://example.com/a,1767225600,notes,unread",
        "A,https://example.com/a,1767225600,birds,unread",
      ].join("\n"),
      "part.csv",
    ),
    FIXTURE_OBSERVED_AT,
  );
  expect(events.map((event) => event.source_record_id)).toEqual([
    "https://example.com/a",
    "https://example.com/a#2",
  ]);
});

test("a url that already ends in a number cannot claim another record", () => {
  const events = pocketEvents(
    parsePocketCsv(
      [
        HEADER,
        "First,https://example.com/a,1767225600,,unread",
        "Chapter two,https://example.com/a#2,1767312000,,unread",
        "Second save,https://example.com/a,1767398400,,unread",
      ].join("\n"),
      "part.csv",
    ),
    FIXTURE_OBSERVED_AT,
  );
  const ids = events.map((event) => event.source_record_id);
  expect(new Set(ids).size).toBe(3);
  expect(ids).toEqual([
    "https://example.com/a",
    "https://example.com/a#2",
    "https://example.com/a#3",
  ]);
});
