import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KizukiError } from "../src/errors";
import {
  POCKET_FIXTURE_EXPORT,
  createPocketImportConnector,
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
