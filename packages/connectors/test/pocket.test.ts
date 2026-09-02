import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  readPocketRows,
} from "../src/import-pocket";
import type { PocketImportConfig } from "../src/import-pocket";

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

async function rejected(body: () => Promise<unknown>): Promise<KizukiError> {
  try {
    await body();
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
      occurred_at: "2026-01-01T00:00:00.000Z",
      tags: [],
      status: "unread",
    },
  ]);
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

test("the byte and row budgets are spent across the whole export", async () => {
  await withTempRoot(async (root) => {
    const first = path.join(root, "part_000000.csv");
    const second = path.join(root, "part_000001.csv");
    const body = (name: string, at: string): string =>
      `${HEADER}\n${name},https://example.com/${name},${at},,unread\n`;
    await writeFile(first, body("first", "1767225600"));
    await writeFile(second, body("second", "1767312000"));
    const size = body("first", "1767225600").length;

    expect((await readPocketRows([first, second])).length).toBe(2);
    const bytes = await rejected(() =>
      readPocketRows([first, second], { maxBytes: size + 1 }),
    );
    expect(bytes.code).toBe("misconfigured");
    expect(bytes.message).toContain("import limit");
    const rows = await rejected(() =>
      readPocketRows([first, second], { maxRows: 1 }),
    );
    expect(rows.code).toBe("parse_error");
    expect(rows.message).toContain("export holds more than 1 rows");
  });
});

test("the export budget is charged the bytes read, not the bytes kept", async () => {
  await withTempRoot(async (root) => {
    const first = path.join(root, "part_000000.csv");
    const second = path.join(root, "part_000001.csv");
    const body = (name: string, at: string): string =>
      `${HEADER}\r\n${name},https://example.com/${name},${at},,unread\r\n`;
    const raw = Buffer.byteLength(body("alpha", "1767225600"), "utf8");
    await writeFile(first, body("alpha", "1767225600"));
    await writeFile(second, body("omega", "1767312000"));

    // A budget one byte short of both files must not stretch to cover them
    // because normalizing CRLF made the kept text smaller than the file.
    const error = await rejected(() =>
      readPocketRows([first, second], { maxBytes: raw * 2 - 1 }),
    );
    expect(error.code).toBe("misconfigured");
    expect(error.message).toContain("import limit");
    expect((await readPocketRows([first, second], { maxBytes: raw * 2 })).length).toBe(2);
  });
});

test("an export with more rows than a call can carry still parses", async () => {
  await withTempRoot(async (root) => {
    // Above the number of arguments a spread `push` can pass, and well under
    // the export's own row bound: a legal export, not a hostile one.
    const count = 700_000;
    const file = path.join(root, "part_000000.csv");
    await writeFile(file, `url,time_added\n${"https://example.com/a,1\n".repeat(count)}`);
    const rows = await readPocketRows([file]);
    expect(rows.length).toBe(count);
    expect(rows[count - 1]?.url).toBe("https://example.com/a");
  });
});

test("a zip path is refused with an actionable message", async () => {
  await withTempRoot(async (root) => {
    const zip = path.join(root, "pocket.zip");
    await writeFile(zip, "PK");
    const connector = createPocketImportConnector({ path: zip });
    const error = await rejected(() => connector.backfill(null));
    expect(error.code).toBe("misconfigured");
    expect(error.message).toContain("unzip the export first");
    expect((await connector.health()).state).toBe("misconfigured");
  });
});

test("a directory without a CSV is refused and health says so", async () => {
  await withTempRoot(async (root) => {
    const connector = createPocketImportConnector({ path: root });
    expect((await rejected(() => connector.backfill(null))).message).toContain(
      "no part_*.csv export in",
    );
    const report = await connector.health();
    expect(report.state).toBe("misconfigured");
    expect(report.detail).toContain(root);
  });
});

test("only the export's own part names are taken from a directory", async () => {
  await withTempRoot(async (root) => {
    // A name from inside an export reaches a refusal and `kizuki doctor`;
    // anything but the shape the export writes is not read at all.
    const hostile = "pocket\u0007\u001b[31m.csv";
    await writeFile(path.join(root, hostile), POCKET_FIXTURE_EXPORT);
    const connector = createPocketImportConnector({ path: root });
    const report = await connector.health();
    expect(report.state).toBe("misconfigured");
    expect(report.detail).toContain("no part_*.csv export in");
    expect(report.detail).not.toContain("\u0007");
    const error = await rejected(() => connector.backfill(null));
    expect(error.message).not.toContain("\u0007");

    await writeFile(path.join(root, "part_000000.csv"), POCKET_FIXTURE_EXPORT);
    const found = createPocketImportConnector({ path: root });
    expect((await found.health()).state).toBe("ok");
    expect((await found.backfill(null)).events.length).toBe(4);
  });
});

test("health opens a CSV rather than trusting the extension", async () => {
  await withTempRoot(async (root) => {
    const file = path.join(root, "part_000000.csv");
    const title = "Quartz heron field notes";

    await writeFile(file, `title,tags,status\n${title},b,unread\n`);
    const foreign = await createPocketImportConnector({ path: root }).health();
    expect(foreign.state).toBe("misconfigured");
    expect(foreign.detail).toContain("not a Pocket CSV export");
    expect(foreign.detail).not.toContain("heron");

    await writeFile(file, Buffer.from([0x41, 0xff, 0x42, 0x0a]));
    const invalid = await createPocketImportConnector({ path: root }).health();
    expect(invalid.state).toBe("misconfigured");
    expect(invalid.detail).toContain("not valid UTF-8");

    await writeFile(file, POCKET_FIXTURE_EXPORT);
    expect(
      (await createPocketImportConnector({ path: root }).health()).state,
    ).toBe("ok");
  });
});

test("an export directory that cannot be listed is refused, not thrown", async () => {
  await withTempRoot(async (root) => {
    const locked = path.join(root, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const connector = createPocketImportConnector({ path: locked });
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
    createPocketImportConnector(config as PocketImportConfig);
  };
  expect(() => construct({ path: "/x" })).not.toThrow();
  for (const config of [{}, { path: "/x", parts: true }]) {
    expect(thrown(() => construct(config)).code).toBe("misconfigured");
  }
});

test("a healthy export reports ok", async () => {
  await withTempRoot(async (root) => {
    const file = path.join(root, "pocket.csv");
    await writeFile(file, POCKET_FIXTURE_EXPORT);
    const connector = createPocketImportConnector({ path: file });
    expect((await connector.health()).state).toBe("ok");
    expect((await connector.backfill(null)).events.length).toBe(4);
    expect(await connector.purgeSource("pocket:self")).toEqual({
      subject_id: "pocket:self",
      source_record_ids: [],
      unreachable_source_record_ids: [
        "https://example.com/heron",
        "https://example.com/heron#2",
        "https://example.com/local-first",
        "https://example.com/quoted",
      ],
    });
    expect(await connector.purgeSource("conformance:subject")).toEqual({
      subject_id: "conformance:subject",
      source_record_ids: [],
      unreachable_source_record_ids: [],
    });
  });
});
