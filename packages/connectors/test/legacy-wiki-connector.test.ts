import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
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
import { initVault, isPlainObject, openLedger, runBatch } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { KizukiError } from "../src/errors";
import { InMemoryLedger } from "../src/ledger";
import {
  LEGACY_WIKI_CONNECTOR_ID,
  createLegacyWikiConnector,
  reconcileSnapshot,
} from "../src/import-legacy-wiki";
import { LEGACY_WIKI_FIXTURE } from "../src/import-legacy-wiki/fixture";
import type { LegacyWikiReport } from "../src/import-legacy-wiki/report";
import {
  confinedDirectory,
  readWikiFile,
} from "../src/import-legacy-wiki/scan";
import type { ScanResult } from "../src/import-legacy-wiki/scan";

const SENTINEL = "a-secret-outside-the-wiki";

/** What this connector's manifest grants: it stages typed pages, not quotes. */
const GRANTED = { page_candidates: true };

function proposalTargets(db: Database, status: "pending" | "withdrawn"): (string | null)[] {
  return db
    .query<{ target: string | null }, [string]>(
      "SELECT target FROM proposals WHERE status = ?",
    )
    .all(status)
    .map((row) => row.target);
}

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

  test("a report inside a vault is refused, symlinked parent included", () => {
    writeMapping();
    const vault = join(root, "vault");
    initVault(vault);
    for (const report of [
      join(vault, "entities", "injected.md"),
      join(vault, "report.json"),
    ]) {
      expect(() =>
        createLegacyWikiConnector({ path: wiki, report }),
      ).toThrow(/report path must be outside the vault/);
    }

    // The canon tree reached through a link outside it is still the canon
    // tree: a Markdown file no receipt covers must not land in it.
    symlinkSync(join(vault, "entities"), join(root, "entities-link"));
    expect(() =>
      createLegacyWikiConnector({
        path: wiki,
        report: join(root, "entities-link", "injected.md"),
      }),
    ).toThrow(/report path must be outside the vault/);

    const outside = createLegacyWikiConnector({
      path: wiki,
      report: join(root, "report.json"),
    });
    expect(outside.reportPath).toBe(join(root, "report.json"));
  });

  test("the manifest declares an unauthenticated page importer", () => {
    writeMapping();
    expect(createLegacyWikiConnector({ path: wiki }).manifest()).toEqual({
      schema: "kizuki.connector/v1",
      connector_id: LEGACY_WIKI_CONNECTOR_ID,
      version: "0.1.0",
      contract_minor: 1,
      implementation: "@kizuki/connectors",
      allowed_egress: [],
      cursor_schema: "kizuki.legacy-wiki-cursor/v1",
      kinds: ["page"],
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: true,
        purge: false,
        fixture: true,
        page_candidates: true,
      },
      required_secrets: [],
      emits_sensitivity_hint: true,
      default_sensitivity: "private",
      sensitivity_floor: "personal",
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

  test("backfill resumes its returned snapshot to exhaustion after a restart", async () => {
    seed();
    const first = await createLegacyWikiConnector({ path: wiki }).backfill(null);
    const resumed = await createLegacyWikiConnector({ path: wiki }).backfill(first.cursor);
    expect(resumed.events).toEqual([]);
    expect(resumed.cursor).toBe(first.cursor);
    write("people/newcomer.md", "---\ntitle: Newcomer\n---\nNew.\n");
    const changed = await createLegacyWikiConnector({ path: wiki }).backfill(resumed.cursor);
    expect(changed.events.map((event) => event.source_record_id)).toEqual(["people/newcomer.md"]);
    expect((await createLegacyWikiConnector({ path: wiki }).backfill(changed.cursor)).events).toEqual([]);
    const fresh = await createLegacyWikiConnector({ path: wiki }).backfill(null);
    expect(fresh.events).toHaveLength(first.events.length + 1);
  });

  test("a page re-emitted later is the event backfill already produced", async () => {
    writeMapping();
    write("a/note.md", "one\n");
    write("b/note.md", "two\n");
    const connector = createLegacyWikiConnector({ path: wiki });
    const first = await connector.backfill(null);
    const before = first.events.find((e) => e.source_record_id === "b/note.md");
    expect(
      (before?.metadata["page_candidate"] as { target: string }).target,
    ).toBe("entities/note-2");

    write("b/note.md", "edited\n");
    const edited = await connector.sync(first.cursor);
    write("b/note.md", "two\n");
    const reverted = await connector.sync(edited.cursor);
    const after = reverted.events.find(
      (e) => e.source_record_id === "b/note.md",
    );

    // Same bytes, same mapping, same decision record. The ledger dedupes on a
    // hash that covers the metadata, so a suffix note that appeared only on
    // the run that decided it would file the page a second time.
    expect(after?.metadata).toEqual(before?.metadata as Record<string, unknown>);
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

  test("a page the mapping never imported has nothing to withdraw", async () => {
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

  test("a page the mapping stops importing is withdrawn, not left staged", async () => {
    seed();
    const first = await createLegacyWikiConnector({ path: wiki }).backfill(
      null,
    );
    const db = openLedger(":memory:");
    runBatch(db, first, GRANTED);
    expect(proposalTargets(db, "pending")).toContain("entities/ada");

    // The owner decides the estate's people are not pages after all.
    writeMapping({
      type: {
        field: "type",
        values: { Person: null, Template: null },
        default: "topic",
      },
    });
    const connector = createLegacyWikiConnector({ path: wiki });
    const second = await connector.sync(first.cursor);
    const withdrawn = second.events.filter((event) => event.deleted);
    // linus carries no type at all, so it keeps the mapping default.
    expect(withdrawn.map((event) => event.source_record_id)).toEqual([
      "people/ada.md",
      "people/grace.md",
    ]);
    // Still on the owner's disk: the record says it left the import, and does
    // not claim a deletion that never happened.
    expect(withdrawn[0]?.metadata).toEqual({
      relpath: "people/ada.md",
      excluded_by_mapping: true,
    });

    runBatch(db, second, GRANTED);
    expect(proposalTargets(db, "pending")).not.toContain("entities/ada");
    expect(proposalTargets(db, "withdrawn").length).toBeGreaterThan(0);

    // Once: the snapshot no longer carries a page it has already withdrawn.
    const third = await connector.sync(second.cursor);
    expect(third.events.filter((event) => event.deleted)).toEqual([]);
    db.close();
  });

  test("a page the ignore list starts matching is withdrawn too", async () => {
    seed();
    const first = await createLegacyWikiConnector({ path: wiki }).backfill(
      null,
    );
    writeMapping({ ignore: ["drafts/**", "notes/**"] });
    const connector = createLegacyWikiConnector({ path: wiki });
    const second = await connector.sync(first.cursor);
    expect(
      second.events
        .filter((event) => event.deleted)
        .map((event) => event.source_record_id),
    ).toEqual([
      "notes/broken.md",
      "notes/no-frontmatter.md",
      "notes/plan.md",
    ]);
  });

  test("a page unreadable on one run can still be withdrawn on the next", async () => {
    seed();
    const connector = createLegacyWikiConnector({ path: wiki });
    const first = await connector.backfill(null);
    // The run learns nothing about this page, so the snapshot has to keep it:
    // dropping it here is what makes the deletion below unreportable.
    writeFileSync(join(wiki, "notes/plan.md"), Buffer.from([0xff, 0xfe, 0x00]));
    const second = await connector.sync(first.cursor);
    expect(second.events).toEqual([]);
    const snapshot = JSON.parse(second.cursor ?? "{}") as {
      files: Record<string, unknown>;
    };
    expect(Object.keys(snapshot.files)).toContain("notes/plan.md");

    rmSync(join(wiki, "notes/plan.md"));
    const third = await connector.sync(second.cursor);
    expect(third.events.map((event) => event.source_record_id)).toEqual([
      "notes/plan.md",
    ]);
    expect(third.events[0]?.metadata).toEqual({ relpath: "notes/plan.md" });
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
      second.events.map(
        (event) => `${event.source_record_id}=${target(event)}`,
      ),
    ).toEqual(["journal/ada.md=entities/ada-2"]);
    expect(
      connector
        .lastReport()
        ?.pages.map((page) => `${page.relpath}=${page.target}`),
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

  test("a directory that resolves outside the wiki is not entered", async () => {
    seed();
    const outside = join(root, "outside");
    mkdirSync(join(outside, "secrets"), { recursive: true });
    writeFileSync(join(outside, "secrets", "leak.md"), "SENTINEL-OUTSIDE\n");

    // The listing's entry type is a snapshot; the walk decides containment
    // against where the directory really is, and descends that path.
    expect(await confinedDirectory(wiki, join(wiki, "people"))).toBe(
      join(wiki, "people"),
    );
    symlinkSync(join(outside, "secrets"), join(root, "escape"));
    expect(await confinedDirectory(wiki, join(root, "escape"))).toBeNull();
    expect(await confinedDirectory(wiki, join(wiki, "absent"))).toBeNull();

    const batch = await createLegacyWikiConnector({ path: wiki }).backfill(null);
    expect(JSON.stringify(batch.events)).not.toContain("SENTINEL-OUTSIDE");
  });

  test("a wiki reached through a symlinked root still scans", async () => {
    seed();
    const link = join(root, "wiki-link");
    symlinkSync(wiki, link);
    const viaLink = await createLegacyWikiConnector({ path: link }).backfill(
      null,
    );
    const direct = await createLegacyWikiConnector({ path: wiki }).backfill(
      null,
    );
    expect(viaLink.events.map((event) => event.source_record_id)).toEqual(
      direct.events.map((event) => event.source_record_id),
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

  test("a file name that is not UTF-8 is reported, never guessed at", async () => {
    writeMapping();
    write("ok.md", "---\ntitle: Fine\n---\nfine\n");
    // A POSIX name is bytes; the listing decodes it lossily, so the name the
    // walk holds does not open the file it came from. Importing under the
    // mangled name would mint a source_record_id that changes between runs.
    writeFileSync(
      Buffer.concat([
        Buffer.from(join(wiki, "bad")),
        Buffer.from([0xff, 0xfe]),
        Buffer.from("name.md"),
      ]),
      "---\ntitle: Bad\n---\nbody\n",
    );
    const connector = createLegacyWikiConnector({ path: wiki });
    const batch = await connector.backfill(null);
    expect(batch.events.map((event) => event.source_record_id)).toEqual([
      "ok.md",
    ]);
    const skipped = connector
      .lastReport()
      ?.pages.filter((page) => page.outcome === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped?.[0]?.skip_reason).toBe("unreadable");
    expect(skipped?.[0]?.relpath).toContain("�");
  });

  // chmod is only a bound for a process that is not root.
  test.skipIf(process.getuid?.() === 0)(
    "one unreadable directory does not take the whole wiki down",
    async () => {
      writeMapping();
      write("ok.md", "---\ntitle: Fine\n---\nfine\n");
      mkdirSync(join(wiki, "private"));
      writeFileSync(join(wiki, "private", "secret.md"), "---\ntitle: S\n---\n");
      chmodSync(join(wiki, "private"), 0o000);
      try {
        const connector = createLegacyWikiConnector({ path: wiki });
        const batch = await connector.backfill(null);
        expect(batch.events.map((event) => event.source_record_id)).toEqual([
          "ok.md",
        ]);
        expect(connector.lastReport()?.pages).toContainEqual(
          expect.objectContaining({
            relpath: "private",
            outcome: "skipped",
            skip_reason: "unreadable",
          }),
        );
      } finally {
        chmodSync(join(wiki, "private"), 0o700);
      }
    },
  );

  test("a root the walk cannot read is still a refusal", async () => {
    writeMapping();
    const connector = createLegacyWikiConnector({ path: wiki });
    rmSync(wiki, { recursive: true, force: true });
    let code = "";
    try {
      await connector.backfill(null);
    } catch (error) {
      if (!(error instanceof KizukiError)) throw error;
      code = error.code;
    }
    expect(code).toBe("misconfigured");
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

  test("a parent swapped for a link into a vault is refused at write time", async () => {
    seed();
    const reports = join(root, "reports");
    mkdirSync(reports);
    const connector = createLegacyWikiConnector({
      path: wiki,
      report: join(reports, "report.md"),
    });
    // Everything the constructor checked was true when it checked it. The
    // directory it approved is then replaced by a link into a canon tree.
    const vault = join(root, "vault");
    initVault(vault);
    rmSync(reports, { recursive: true });
    symlinkSync(join(vault, "entities"), reports);

    await expect(connector.backfill(null)).rejects.toThrow(
      /report path must be outside the vault/,
    );
    expect(existsSync(join(vault, "entities", "report.md"))).toBe(false);
    expect(readdirSync(join(vault, "entities"))).toEqual([]);
  });

  test("a report directory removed after configuration is a refusal", async () => {
    seed();
    const reports = join(root, "reports");
    mkdirSync(reports);
    const connector = createLegacyWikiConnector({
      path: wiki,
      report: join(reports, "report.json"),
    });
    rmSync(reports, { recursive: true });
    await expect(connector.backfill(null)).rejects.toThrow(
      /report parent directory does not exist/,
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

describe("reconciling a snapshot with what a run saw", () => {
  const snapshot = { "a.md": { hash: "h", target: "entities/a" } };
  const scanned = (over: Partial<ScanResult> = {}): ScanResult => ({
    files: [],
    skipped: [],
    truncated: false,
    ...over,
  });
  const nothing = new Set<string>();

  test("a relpath this walk never saw is gone from the source", () => {
    expect(reconcileSnapshot(snapshot, scanned(), nothing)).toEqual({
      withdrawn: [{ relpath: "a.md", reason: "absent" }],
      carried: [],
    });
  });

  test("a relpath this run emitted needs no decision at all", () => {
    const files = [{ relpath: "a.md", content: "x", mtimeMs: 1, size: 1 }];
    expect(
      reconcileSnapshot(snapshot, scanned({ files }), new Set(["a.md"])),
    ).toEqual({ withdrawn: [], carried: [] });
  });

  test("a page still on disk that this run did not import is excluded", () => {
    // The mapping stopped importing it — an excluded type, say. The file is
    // there, so the ledger is told it left the import, not that it was
    // deleted.
    const files = [{ relpath: "a.md", content: "x", mtimeMs: 1, size: 1 }];
    expect(reconcileSnapshot(snapshot, scanned({ files }), nothing)).toEqual({
      withdrawn: [{ relpath: "a.md", reason: "excluded" }],
      carried: [],
    });
  });

  test("a relpath the ignore list now matches is excluded too", () => {
    const skipped = [
      { relpath: "a.md", reason: "ignored" as const, kind: "file" as const },
    ];
    expect(reconcileSnapshot(snapshot, scanned({ skipped }), nothing)).toEqual({
      withdrawn: [{ relpath: "a.md", reason: "excluded" }],
      carried: [],
    });
  });

  test("a relpath this walk could not read proves nothing either way", () => {
    for (const reason of [
      "symlink",
      "not_utf8",
      "too_large",
      "unreadable",
      "depth",
    ] as const) {
      const skipped = [{ relpath: "a.md", reason, kind: "file" as const }];
      expect(
        reconcileSnapshot(snapshot, scanned({ skipped }), nothing),
      ).toEqual({ withdrawn: [], carried: ["a.md"] });
    }
  });

  test("a truncated walk never saw the rest of the wiki", () => {
    expect(
      reconcileSnapshot(snapshot, scanned({ truncated: true }), nothing),
    ).toEqual({ withdrawn: [], carried: ["a.md"] });
  });

  test("a directory the walk could not enter hides everything beneath it", () => {
    const beneath = {
      "private/a.md": { hash: "h", target: "entities/a" },
      "private-notes/b.md": { hash: "h", target: "entities/b" },
    };
    for (const reason of ["depth", "unreadable"] as const) {
      const skipped = [
        { relpath: "private", reason, kind: "directory" as const },
      ];
      // The sibling whose name merely starts with the same characters is
      // outside the subtree and really is gone.
      expect(reconcileSnapshot(beneath, scanned({ skipped }), nothing)).toEqual(
        {
          withdrawn: [{ relpath: "private-notes/b.md", reason: "absent" }],
          carried: ["private/a.md"],
        },
      );
    }
  });

  test("a directory the ignore list now matches withdraws its whole subtree", () => {
    const beneath = { "private/a.md": { hash: "h", target: "entities/a" } };
    const skipped = [
      {
        relpath: "private",
        reason: "ignored" as const,
        kind: "directory" as const,
      },
    ];
    expect(reconcileSnapshot(beneath, scanned({ skipped }), nothing)).toEqual({
      withdrawn: [{ relpath: "private/a.md", reason: "excluded" }],
      carried: [],
    });
  });

  test("an unreadable file hides only itself", () => {
    const skipped = [
      { relpath: "a.md", reason: "not_utf8" as const, kind: "file" as const },
    ];
    expect(
      reconcileSnapshot(
        { ...snapshot, "a.md/b.md": { hash: "h", target: "entities/b" } },
        scanned({ skipped }),
        nothing,
      ),
    ).toEqual({
      withdrawn: [{ relpath: "a.md/b.md", reason: "absent" }],
      carried: ["a.md"],
    });
  });
});
