import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isPlainObject } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { KizukiError } from "../src/errors";
import { InMemoryLedger } from "../src/ledger";
import {
  LEGACY_WIKI_CONNECTOR_ID,
  createLegacyWikiConnector,
  goneFromSnapshot,
} from "../src/import-legacy-wiki";
import { LEGACY_WIKI_FIXTURE } from "../src/import-legacy-wiki/fixture";
import type { LegacyWikiReport } from "../src/import-legacy-wiki/report";
import { readWikiFile } from "../src/import-legacy-wiki/scan";
import type { ScanResult } from "../src/import-legacy-wiki/scan";

const SENTINEL = "a-secret-outside-the-wiki";

function target(event: CaptureEventInput | undefined): string | undefined {
  const candidate = event?.metadata["page_candidate"];
  if (!isPlainObject(candidate)) return undefined;
  const value = candidate["target"];
  return typeof value === "string" ? value : undefined;
}

let root: string;
let wiki: string;

function write(relpath: string, content: string): void {
  const target = join(wiki, relpath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeMapping(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(wiki, "kizuki-mapping.json"),
    JSON.stringify({
      schema: "kizuki.legacy-wiki-mapping/v1",
      type: {
        field: "type",
        values: { Person: "person", Template: null },
        default: "topic",
      },
      sensitivity: { field: "visibility", values: { friends: "personal" } },
      ignore: ["drafts/**"],
      ...overrides,
    }),
  );
}

function seed(): void {
  for (const file of LEGACY_WIKI_FIXTURE.files)
    write(file.relpath, file.content);
  writeMapping();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kizuki-legacy-wiki-"));
  wiki = join(root, "wiki");
  mkdirSync(wiki, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("construction", () => {
  test("a missing mapping names the path it looked for", () => {
    expect(() => createLegacyWikiConnector({ path: wiki })).toThrow(
      `${LEGACY_WIKI_CONNECTOR_ID}: mapping file not found: ${join(wiki, "kizuki-mapping.json")}; see docs/legacy-import.md`,
    );
  });

  test("a report inside the wiki is refused before any file is read", () => {
    writeMapping();
    expect(() =>
      createLegacyWikiConnector({
        path: wiki,
        report: join(wiki, "report.md"),
      }),
    ).toThrow(/report path must be outside the source/);
  });

  test("the manifest declares an unauthenticated page importer", () => {
    writeMapping();
    expect(createLegacyWikiConnector({ path: wiki }).manifest()).toEqual({
      schema: "kizuki.connector/v1",
      connector_id: LEGACY_WIKI_CONNECTOR_ID,
      version: "0.1.0",
      kinds: ["page"],
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: true,
        purge: false,
        fixture: true,
      },
      required_secrets: [],
      emits_sensitivity_hint: true,
      auth_modes: ["none"],
    });
  });
});

describe("backfill and sync", () => {
  test("backfill walks the wiki and skips the ignored directory", async () => {
    seed();
    const connector = createLegacyWikiConnector({ path: wiki });
    const batch = await connector.backfill(null);
    expect(batch.events.map((event) => event.source_record_id)).toEqual([
      "journal/2026-01-01.md",
      "notes/broken.md",
      "notes/no-frontmatter.md",
      "notes/plan.md",
      "orgs/acme.md",
      "people/ada.md",
      "people/grace.md",
      "people/linus.md",
    ]);
    expect(batch.cursor).not.toBeNull();
  });

  test("sync emits only the pages that changed", async () => {
    seed();
    const connector = createLegacyWikiConnector({ path: wiki });
    const first = await connector.backfill(null);
    expect((await connector.sync(first.cursor)).events).toEqual([]);

    write("people/linus.md", "---\ntitle: Linus\n---\nEdited.\n");
    write("people/newcomer.md", "---\ntitle: Newcomer\n---\nNew.\n");
    const second = await connector.sync(first.cursor);
    expect(second.events.map((event) => event.source_record_id)).toEqual([
      "people/linus.md",
      "people/newcomer.md",
    ]);
  });

  test("a removed page becomes a tombstone with an empty body", async () => {
    seed();
    const connector = createLegacyWikiConnector({ path: wiki });
    const first = await connector.backfill(null);
    rmSync(join(wiki, "notes/plan.md"));
    const second = await connector.sync(first.cursor);
    expect(second.events).toEqual([
      {
        schema: "kizuki.event/v1",
        connector_id: LEGACY_WIKI_CONNECTOR_ID,
        source_record_id: "notes/plan.md",
        kind: "page",
        occurred_at: expect.any(String),
        observed_at: expect.any(String),
        text: "",
        subjects: [],
        deleted: true,
        attachments: [],
        metadata: { relpath: "notes/plan.md" },
      },
    ]);
  });

  test("a page the scan could not read is not reported deleted", async () => {
    seed();
    const connector = createLegacyWikiConnector({ path: wiki });
    const first = await connector.backfill(null);
    // Still on disk, no longer decodable: a skip is missing information, and
    // a tombstone would withdraw the page's proposals on the strength of it.
    writeFileSync(join(wiki, "people/ada.md"), Buffer.from([0xff, 0xfe, 0x00]));
    const second = await connector.sync(first.cursor);
    expect(second.events).toEqual([]);
    expect(
      connector
        .lastReport()
        ?.pages.find((entry) => entry.relpath === "people/ada.md"),
    ).toMatchObject({ outcome: "skipped", skip_reason: "not_utf8" });
  });

  test("a page the mapping excludes is never tombstoned", async () => {
    seed();
    const connector = createLegacyWikiConnector({ path: wiki });
    const first = await connector.backfill(null);
    const snapshot = JSON.parse(first.cursor ?? "{}") as {
      files: Record<string, { hash: string; target: string }>;
    };
    expect(Object.keys(snapshot.files)).not.toContain("templates/person.md");
    rmSync(join(wiki, "templates/person.md"));
    expect((await connector.sync(first.cursor)).events).toEqual([]);
  });

  test("a page added later cannot take a target already emitted", async () => {
    write("notes/ada.md", "---\ntitle: Ada\n---\nFirst.\n");
    writeMapping();
    const connector = createLegacyWikiConnector({ path: wiki });
    const first = await connector.backfill(null);
    expect(target(first.events[0])).toBe("entities/ada");

    // Sorts ahead of notes/ada.md, so a fresh plan would hand it the
    // unsuffixed target the earlier page was already emitted with.
    write("journal/ada.md", "---\ntitle: Ada\n---\nSecond.\n");
    const second = await connector.sync(first.cursor);
    expect(
      second.events.map((event) => `${event.source_record_id}=${target(event)}`),
    ).toEqual(["journal/ada.md=entities/ada-2"]);
    expect(
      connector.lastReport()?.pages.map((page) => `${page.relpath}=${page.target}`),
    ).toEqual(["journal/ada.md=entities/ada-2", "notes/ada.md=entities/ada"]);
  });

  test("a changed mapping re-emits every page and the report says why", async () => {
    seed();
    const first = await createLegacyWikiConnector({ path: wiki }).backfill(
      null,
    );
    writeMapping({
      sensitivity: { field: "visibility", values: { friends: "private" } },
    });
    const connector = createLegacyWikiConnector({ path: wiki });
    const second = await connector.sync(first.cursor);
    expect(second.events).toHaveLength(8);
    expect(connector.lastReport()?.notes).toEqual(["mapping_changed"]);
  });

  test("a malformed cursor is a parse error, not a silent full walk", async () => {
    seed();
    const connector = createLegacyWikiConnector({ path: wiki });
    for (const cursor of [
      "{",
      "{}",
      '{"schema":"other","mapping_hash":"a","files":{}}',
    ]) {
      let code = "";
      try {
        await connector.sync(cursor);
      } catch (error) {
        if (!(error instanceof KizukiError)) throw error;
        code = error.code;
      }
      expect(code).toBe("parse_error");
    }
  });

  test("backfill twice produces the same evidence, so the ledger dedupes", async () => {
    seed();
    const connector = createLegacyWikiConnector({ path: wiki });
    const first = await connector.backfill(null);
    const second = await connector.backfill(null);
    // `observed_at` is when the walk ran and is outside the content hash;
    // everything the ledger keys on must match exactly.
    const identity = (batch: typeof first): unknown =>
      batch.events.map(({ observed_at: _when, ...rest }) => rest);
    expect(identity(first)).toEqual(identity(second));

    const ledger = new InMemoryLedger();
    expect(
      ledger.acceptMany(first.events).every((r) => r.status === "stored"),
    ).toBe(true);
    expect(
      ledger.acceptMany(second.events).every((r) => r.status === "duplicate"),
    ).toBe(true);
  });
});

describe("hostile files", () => {
  test("a symlink out of the wiki is skipped, never read", async () => {
    writeMapping();
    const outside = join(root, "outside.md");
    writeFileSync(outside, `---\ntitle: Outside\n---\n${SENTINEL}\n`);
    symlinkSync(outside, join(wiki, "linked.md"));
    write("inside.md", "---\ntitle: Inside\n---\nfine\n");

    const connector = createLegacyWikiConnector({ path: wiki });
    const batch = await connector.backfill(null);
    expect(batch.events.map((event) => event.source_record_id)).toEqual([
      "inside.md",
    ]);
    expect(JSON.stringify(batch.events)).not.toContain(SENTINEL);
    expect(connector.lastReport()?.pages).toContainEqual(
      expect.objectContaining({ relpath: "linked.md", skip_reason: "symlink" }),
    );
  });

  test("a file that is not UTF-8 is skipped and reported", async () => {
    writeMapping();
    write("ok.md", "---\ntitle: Fine\n---\nfine\n");
    writeFileSync(
      join(wiki, "binary.md"),
      Buffer.from([0xff, 0xfe, 0x00, 0x41]),
    );
    const connector = createLegacyWikiConnector({ path: wiki });
    const batch = await connector.backfill(null);
    expect(batch.events).toHaveLength(1);
    expect(connector.lastReport()?.pages).toContainEqual(
      expect.objectContaining({
        relpath: "binary.md",
        skip_reason: "not_utf8",
      }),
    );
  });

  test("a file over the size cap is skipped", async () => {
    writeMapping();
    write("ok.md", "---\ntitle: Fine\n---\nfine\n");
    writeFileSync(join(wiki, "huge.md"), "x".repeat(4 * 1024 * 1024 + 1));
    const connector = createLegacyWikiConnector({ path: wiki });
    await connector.backfill(null);
    expect(connector.lastReport()?.pages).toContainEqual(
      expect.objectContaining({ relpath: "huge.md", skip_reason: "too_large" }),
    );
  });

  test("the reader refuses a link even when the listing called it a file", async () => {
    // The dirent check runs before the open, and an entry can be replaced in
    // between; the open itself has to refuse to follow.
    const outside = join(root, "outside.md");
    writeFileSync(outside, SENTINEL);
    const link = join(wiki, "linked.md");
    symlinkSync(outside, link);
    expect(await readWikiFile(link)).toEqual({ reason: "symlink" });
  });

  test("the reader refuses anything that is not a regular file", async () => {
    mkdirSync(join(wiki, "folder.md"));
    expect(await readWikiFile(join(wiki, "folder.md"))).toEqual({
      reason: "unreadable",
    });
    expect(await readWikiFile(join(wiki, "absent.md"))).toEqual({
      reason: "unreadable",
    });
  });

  test("the reader bounds the read by the descriptor, not by an old stat", async () => {
    const page = join(wiki, "page.md");
    writeFileSync(page, "body\n");
    expect(await readWikiFile(page)).toEqual({
      file: { content: "body\n", mtimeMs: expect.any(Number), size: 5 },
    });
    writeFileSync(join(wiki, "huge.md"), "x".repeat(4 * 1024 * 1024 + 1));
    expect(await readWikiFile(join(wiki, "huge.md"))).toEqual({
      reason: "too_large",
    });
    // At the cap exactly: the read has to fill the buffer, not stop at
    // whatever the first read(2) happened to return.
    const big = "y".repeat(4 * 1024 * 1024);
    writeFileSync(join(wiki, "big.md"), big);
    const read = await readWikiFile(join(wiki, "big.md"));
    expect("file" in read && read.file.content).toBe(big);
    expect("file" in read && read.file.size).toBe(big.length);
  });

  test("health degrades after a run that skipped unreadable pages", async () => {
    writeMapping();
    write("ok.md", "---\ntitle: Fine\n---\nfine\n");
    writeFileSync(join(wiki, "binary.md"), Buffer.from([0xff, 0xfe]));
    const connector = createLegacyWikiConnector({ path: wiki });
    expect((await connector.health()).state).toBe("ok");
    await connector.backfill(null);
    const health = await connector.health();
    expect(health.state).toBe("degraded");
    expect(health.detail).toBe("1 file(s) skipped; see the report");
  });
});

describe("the report file", () => {
  test("JSON for a .json path, owner-readable only, with no leftovers", async () => {
    seed();
    const reportPath = join(root, "report.json");
    const connector = createLegacyWikiConnector({
      path: wiki,
      report: reportPath,
    });
    await connector.backfill(null);

    expect(statSync(reportPath).mode & 0o777).toBe(0o600);
    const written = JSON.parse(
      readFileSync(reportPath, "utf8"),
    ) as LegacyWikiReport;
    expect(written).toEqual(connector.lastReport() as LegacyWikiReport);
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  test("Markdown for any other suffix, with no page prose in it", async () => {
    seed();
    const reportPath = join(root, "report.md");
    const connector = createLegacyWikiConnector({
      path: wiki,
      report: reportPath,
    });
    await connector.backfill(null);
    const markdown = readFileSync(reportPath, "utf8");
    expect(markdown).toContain("# Legacy wiki import report");
    expect(markdown).toContain("## people/ada.md");
    expect(markdown).not.toContain("Met at the");
    expect(markdown).not.toContain(root);
  });

  test("a rewritten report replaces the previous one atomically", async () => {
    seed();
    const reportPath = join(root, "report.json");
    const connector = createLegacyWikiConnector({
      path: wiki,
      report: reportPath,
    });
    await connector.backfill(null);
    chmodSync(reportPath, 0o600);
    rmSync(join(wiki, "notes/plan.md"));
    await connector.backfill(null);
    const written = JSON.parse(
      readFileSync(reportPath, "utf8"),
    ) as LegacyWikiReport;
    expect(written.counts.files).toBe(9);
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  test("no report file is written when the owner did not ask for one", async () => {
    seed();
    const connector = createLegacyWikiConnector({ path: wiki });
    await connector.backfill(null);
    expect(connector.lastReport()).not.toBeNull();
    expect(readdirSync(root)).toEqual(["wiki"]);
  });
});

describe("what counts as gone from a snapshot", () => {
  const snapshot = { "a.md": { hash: "h", target: "entities/a" } };
  const scanned = (over: Partial<ScanResult> = {}): ScanResult => ({
    files: [],
    skipped: [],
    truncated: false,
    ...over,
  });

  test("a relpath this walk never saw is gone", () => {
    expect(goneFromSnapshot(snapshot, scanned())).toEqual(["a.md"]);
  });

  test("a relpath this walk read is still here", () => {
    const files = [{ relpath: "a.md", content: "x", mtimeMs: 1, size: 1 }];
    expect(goneFromSnapshot(snapshot, scanned({ files }))).toEqual([]);
  });

  test("a relpath this walk skipped proves nothing either way", () => {
    const reasons = [
      "symlink",
      "not_utf8",
      "too_large",
      "unreadable",
      "ignored",
      "depth",
    ] as const;
    for (const reason of reasons) {
      const skipped = [{ relpath: "a.md", reason }];
      expect(goneFromSnapshot(snapshot, scanned({ skipped }))).toEqual([]);
    }
  });

  test("a truncated walk never saw the rest of the wiki", () => {
    expect(goneFromSnapshot(snapshot, scanned({ truncated: true }))).toEqual(
      [],
    );
  });
});
