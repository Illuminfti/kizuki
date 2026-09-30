import { describe, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  massWithdrawalHoldOf,
  registerConnection,
  runToCompletion,
  setSourceGrant,
} from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import {
  markdownCommittedIdentities,
  wikiCommittedIdentities,
} from "../../cli/src/connections";
import { recordHistory } from "../../cli/src/mirror-history";
import {
  LEGACY_WIKI_CONNECTOR_ID,
  MARKDOWN_FOLDER_CONNECTOR_ID,
  createLegacyWikiConnector,
  createMarkdownFolderConnector,
} from "../src";

/**
 * The two mirrors drive the same lifecycle through the real ingest rail and
 * the host's ledger readers: a source that empties, comes back, is renamed or
 * is edited must leave the ledger and the staged claims where the source is.
 */

const SOURCE = "01JJ0000000000000000000001";
const PAST = new Date("2026-01-01T00:00:00Z");

type Ledger = ReturnType<typeof openLedger>;

interface Mirror {
  id: string;
  /** The tree's directory. */
  dir: string;
  /** Writes one page or note, with a fixed modification time. */
  put(name: string, text: string): void;
  name(index: number): string;
  connector(options?: {
    confirm?: number;
  }): ReturnType<typeof createMarkdownFolderConnector>;
}

function grant(db: Ledger, id: string): void {
  registerConnection(db, id, SOURCE);
  setSourceGrant(db, {
    source_key: SOURCE,
    expected_revision: 0,
    operation_id: `grant-${id}`,
    policy: {
      purposes: ["capture", "recall", "derive"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "private",
    },
  });
}

const MAPPING = JSON.stringify({
  schema: "kizuki.legacy-wiki-mapping/v1",
  type: {
    field: "type",
    values: { Secret: "person", Skip: null },
    default: "topic",
  },
  sensitivity: { field: "visibility", values: {} },
  ignore: [],
});

function folder(root: string, db: Ledger): Mirror {
  const dir = join(root, "notes");
  mkdirSync(dir, { recursive: true });
  return {
    id: MARKDOWN_FOLDER_CONNECTOR_ID,
    dir,
    put(name, text) {
      const path = join(dir, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
      utimesSync(path, PAST, PAST);
    },
    name: (index) => `n${String(index).padStart(3, "0")}.md`,
    connector: (options = {}) =>
      createMarkdownFolderConnector(
        { path: dir },
        {
          committedFiles: () => markdownCommittedIdentities(db, SOURCE),
          recordHistory: (relpaths) =>
            recordHistory(db, MARKDOWN_FOLDER_CONNECTOR_ID, SOURCE, relpaths),
          ...(options.confirm === undefined
            ? {}
            : { confirmWithdrawals: options.confirm }),
        },
      ),
  };
}

function wiki(root: string, db: Ledger): Mirror {
  const dir = join(root, "wiki");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "kizuki-mapping.json"), MAPPING);
  return {
    id: LEGACY_WIKI_CONNECTOR_ID,
    dir,
    put(name, text) {
      const path = join(dir, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
      utimesSync(path, PAST, PAST);
    },
    name: (index) => `p${String(index).padStart(3, "0")}.md`,
    connector: (options = {}) =>
      createLegacyWikiConnector(
        { path: dir },
        {
          committedFiles: () => wikiCommittedIdentities(db, SOURCE),
          recordHistory: (relpaths) =>
            recordHistory(db, LEGACY_WIKI_CONNECTOR_ID, SOURCE, relpaths),
          ...(options.confirm === undefined
            ? {}
            : { confirmWithdrawals: options.confirm }),
        },
      ) as never,
  };
}

const KINDS = [
  { label: "folder", make: folder, body: (text: string) => `${text}\n` },
  {
    label: "wiki",
    make: wiki,
    body: (text: string) => `---\ntitle: ${text}\n---\n${text}\n`,
  },
] as const;

interface Harness {
  root: string;
  db: Ledger;
  mirror: Mirror;
  put(index: number, text?: string): void;
  remove(index: number): void;
  sync(options?: { confirm?: number }): ReturnType<typeof runToCompletion>;
  events(): Array<{
    id: string;
    deleted: number;
    text: string;
    metadata: Record<string, unknown>;
  }>;
  dispose(): void;
}

function harness(kind: (typeof KINDS)[number]): Harness {
  const root = mkdtempSync(join(tmpdir(), "kizuki-mirror-"));
  const db = openLedger(":memory:");
  const mirror = kind.make(root, db);
  grant(db, mirror.id);
  const put = (index: number, text = `body ${index}`) =>
    mirror.put(mirror.name(index), kind.body(text));
  return {
    root,
    db,
    mirror,
    put,
    remove: (index) => unlinkSync(join(mirror.dir, mirror.name(index))),
    // A wiki needs two passes after its backfill before it withdraws, so a
    // sync here is always "the pass the daemon runs next".
    sync: (options) =>
      runToCompletion(db, mirror.connector(options), mirror.id, SOURCE, "sync"),
    events: () =>
      db
        .query<
          { id: string; deleted: number; text: string; metadata: string },
          []
        >(
          "SELECT source_record_id AS id, deleted, text, metadata FROM events ORDER BY rowid",
        )
        .all()
        .map((row) => ({
          ...row,
          metadata: JSON.parse(row.metadata) as Record<string, unknown>,
        })),
    dispose: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function establish(h: Harness, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) h.put(index);
  const backfill = await runToCompletion(
    h.db,
    h.mirror.connector(),
    h.mirror.id,
    SOURCE,
    "backfill",
  );
  expect(backfill.errors).toEqual([]);
  expect(backfill.stored).toBe(count);
  // The wiki's first sync re-reads from a fresh cursor; settle it before a test changes anything.
  expect((await h.sync()).errors).toEqual([]);
  expect((await h.sync()).stored).toBe(0);
}

for (const kind of KINDS) {
  describe(`${kind.label} mirror follows its source`, () => {
    test("a pass that would withdraw most of the source holds, and a documented confirmation releases it", async () => {
      const h = harness(kind);
      try {
        await establish(h, 50);
        // The root is replaced by a tree holding 3 of the 50 records (6 percent).
        const original = join(h.root, "unmounted");
        renameSync(h.mirror.dir, original);
        mkdirSync(h.mirror.dir);
        if (kind.label === "wiki") writeFileSync(join(h.mirror.dir, "kizuki-mapping.json"), MAPPING);
        for (let index = 0; index < 3; index += 1) h.put(index);
        const held = await h.sync();
        expect(held.stored).toBe(0);
        expect(held.errors).toEqual(["mass_withdrawal_held: 47 of 50"]);
        expect(h.events().filter((event) => event.deleted === 1)).toEqual([]);
        expect(massWithdrawalHoldOf(h.db, h.mirror.id, SOURCE)).toEqual({
          state: "mass_withdrawal_held",
          withdrawn: 47,
          total: 50,
        });
        // Held again on every pass; nothing about the ledger moves.
        expect((await h.sync()).errors).toEqual([
          "mass_withdrawal_held: 47 of 50",
        ]);

        // The tree comes back (a remount): the hold clears with nothing to emit.
        for (let index = 3; index < 50; index += 1) h.put(index);
        const restored = await h.sync();
        expect(restored).toMatchObject({
          stored: 0,
          duplicates: 0,
          errors: [],
        });
        expect(massWithdrawalHoldOf(h.db, h.mirror.id, SOURCE)).toBeNull();
        expect(h.events().filter((event) => event.deleted === 1)).toEqual([]);

        // The source really lost them: a confirmation of the reported count releases exactly that.
        for (let index = 3; index < 50; index += 1) h.remove(index);
        const tooSmall = await h.sync({ confirm: 46 });
        expect(tooSmall.errors).toEqual(["mass_withdrawal_held: 47 of 50"]);
        const released = await h.sync({ confirm: 47 });
        expect(released.errors).toEqual([]);
        expect(released.stored).toBe(47);
        expect(h.events().filter((event) => event.deleted === 1)).toHaveLength(
          47,
        );
        expect(massWithdrawalHoldOf(h.db, h.mirror.id, SOURCE)).toBeNull();
      } finally {
        h.dispose();
      }
    });

    test("a small withdrawal proceeds without a confirmation", async () => {
      const h = harness(kind);
      try {
        await establish(h, 50);
        // Twenty of fifty is at the floor, not past it.
        for (let index = 0; index < 20; index += 1) h.remove(index);
        const result = await h.sync();
        expect(result.errors).toEqual([]);
        expect(result.stored).toBe(20);
        for (let index = 20; index < 30; index += 1) h.remove(index);
        // Ten of the thirty left is well under the allowance.
        expect((await h.sync()).stored).toBe(10);
      } finally {
        h.dispose();
      }
    });

    test("deleting then restoring identical bytes is new state and the next sync emits nothing", async () => {
      const h = harness(kind);
      try {
        await establish(h, 5);
        h.remove(2);
        expect((await h.sync()).stored).toBe(1);
        expect(h.events().at(-1)).toMatchObject({
          id: h.mirror.name(2),
          deleted: 1,
        });
        // A restore keeps the original bytes and modification time.
        h.put(2);
        const restored = await h.sync();
        expect(restored).toMatchObject({
          stored: 1,
          duplicates: 0,
          errors: [],
        });
        const latest = h.events().at(-1)!;
        expect(latest).toMatchObject({ id: h.mirror.name(2), deleted: 0 });
        expect(latest.metadata["revision_epoch"]).toBe(2);
        expect(await h.sync()).toMatchObject({
          stored: 0,
          duplicates: 0,
          errors: [],
        });
        expect(await h.sync()).toMatchObject({
          stored: 0,
          duplicates: 0,
          errors: [],
        });
      } finally {
        h.dispose();
      }
    });

    test("editing to B and back to A leaves A as the latest revision", async () => {
      const h = harness(kind);
      try {
        await establish(h, 3);
        h.put(1, "edited");
        expect((await h.sync()).stored).toBe(1);
        h.put(1);
        const reverted = await h.sync();
        expect(reverted).toMatchObject({
          stored: 1,
          duplicates: 0,
          errors: [],
        });
        const revisions = h
          .events()
          .filter((event) => event.id === h.mirror.name(1));
        expect(
          revisions.map((event) => event.metadata["revision_epoch"]),
        ).toEqual([undefined, 1, 2]);
        expect(revisions.at(-1)!.text).toContain("body 1");
        expect(await h.sync()).toMatchObject({
          stored: 0,
          duplicates: 0,
          errors: [],
        });
      } finally {
        h.dispose();
      }
    });

    test("ten renames are ten events that name their origin, with no tombstones", async () => {
      const h = harness(kind);
      try {
        await establish(h, 12);
        for (let index = 0; index < 10; index += 1) {
          renameSync(
            join(h.mirror.dir, h.mirror.name(index)),
            join(h.mirror.dir, `moved-${h.mirror.name(index)}`),
          );
        }
        const before = h.events().length;
        const result = await h.sync();
        expect(result).toMatchObject({ stored: 10, errors: [] });
        const fresh = h.events().slice(before);
        expect(fresh).toHaveLength(10);
        expect(fresh.every((event) => event.deleted === 0)).toBe(true);
        expect(
          fresh.map((event) => [event.id, event.metadata["moved_from"]]).sort(),
        ).toEqual(
          Array.from({ length: 10 }, (_, index) => [
            `moved-${h.mirror.name(index)}`,
            h.mirror.name(index),
          ]).sort(),
        );
        // The renamed records are the mirror's records now, and stay quiet.
        expect(await h.sync()).toMatchObject({
          stored: 0,
          duplicates: 0,
          errors: [],
        });
        expect(await h.sync()).toMatchObject({
          stored: 0,
          duplicates: 0,
          errors: [],
        });
        expect(h.events().filter((event) => event.deleted === 1)).toEqual([]);
        // And they can move back.
        renameSync(
          join(h.mirror.dir, `moved-${h.mirror.name(0)}`),
          join(h.mirror.dir, h.mirror.name(0)),
        );
        const back = await h.sync();
        expect(back).toMatchObject({ stored: 1, errors: [] });
        expect(h.events().at(-1)).toMatchObject({
          id: h.mirror.name(0),
          deleted: 0,
        });
        expect(await h.sync()).toMatchObject({ stored: 0, errors: [] });
      } finally {
        h.dispose();
      }
    });

    test("two files that share bytes are never guessed to be a rename", async () => {
      const h = harness(kind);
      try {
        await establish(h, 4);
        h.put(10, "twin");
        h.put(11, "twin");
        expect((await h.sync()).stored).toBe(2);
        h.remove(10);
        h.remove(11);
        h.put(12, "twin");
        h.put(13, "twin");
        const result = await h.sync();
        expect(result.stored).toBe(4);
        expect(h.events().at(-4)!.metadata["moved_from"]).toBeUndefined();
        expect(
          h
            .events()
            .filter((event) => event.metadata["moved_from"] !== undefined),
        ).toEqual([]);
      } finally {
        h.dispose();
      }
    });
  });
}

describe("markdown folder follows its folder across a disk migration", () => {
  test("a copy on a new inode resumes from the committed files and emits only real differences", async () => {
    const h = harness(KINDS[0]);
    try {
      await establish(h, 8);
      const copy = join(h.root, "copy");
      cpSync(h.mirror.dir, copy, { recursive: true, preserveTimestamps: true });
      rmSync(h.mirror.dir, { recursive: true, force: true });
      renameSync(copy, h.mirror.dir);
      expect(await h.sync()).toMatchObject({
        stored: 0,
        duplicates: 0,
        errors: [],
      });
      h.put(3, "edited after the migration");
      const edited = await h.sync();
      expect(edited).toMatchObject({ stored: 1, errors: [] });
      expect(h.events().at(-1)).toMatchObject({
        id: h.mirror.name(3),
        deleted: 0,
      });
    } finally {
      h.dispose();
    }
  });

  test("a folder recreated from scratch keeps its checkpoint and holds instead of withdrawing", async () => {
    const h = harness(KINDS[0]);
    try {
      await establish(h, 30);
      rmSync(h.mirror.dir, { recursive: true, force: true });
      mkdirSync(h.mirror.dir);
      const held = await h.sync();
      expect(held.errors).toEqual(["mass_withdrawal_held: 30 of 30"]);
      expect(h.events().filter((event) => event.deleted === 1)).toEqual([]);
    } finally {
      h.dispose();
    }
  });

  test("a snapshot cursor carried without a ledger reader survives a new inode at the same path", async () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-mirror-"));
    try {
      const dir = join(root, "notes");
      mkdirSync(dir);
      for (const name of ["a.md", "b.md"]) {
        writeFileSync(join(dir, name), `${name}\n`);
        utimesSync(join(dir, name), PAST, PAST);
      }
      const connector = createMarkdownFolderConnector({ path: dir });
      const first = await connector.backfill(null);
      expect(first.events).toHaveLength(2);
      const copy = join(root, "copy");
      cpSync(dir, copy, { recursive: true, preserveTimestamps: true });
      rmSync(dir, { recursive: true, force: true });
      renameSync(copy, dir);
      writeFileSync(join(dir, "b.md"), "b edited\n");
      const next = await createMarkdownFolderConnector({ path: dir }).sync(
        first.cursor,
      );
      expect(
        next.events.map((event) => [event.source_record_id, event.deleted]),
      ).toEqual([["b.md", false]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("wiki mapping edits", () => {
  test("an edit that changes no page emits nothing and neither does its revert; a label change re-emits only that page", async () => {
    const h = harness(KINDS[1]);
    try {
      for (let index = 0; index < 6; index += 1) h.put(index);
      h.mirror.put(
        h.mirror.name(6),
        "---\ntitle: Secret one\ntype: Secret\n---\nsecret\n",
      );
      await runToCompletion(
        h.db,
        h.mirror.connector(),
        h.mirror.id,
        SOURCE,
        "backfill",
      );
      await h.sync();
      const settled = h.events().length;
      const mapping = (overrides: Record<string, unknown>) =>
        writeFileSync(
          join(h.mirror.dir, "kizuki-mapping.json"),
          JSON.stringify({ ...JSON.parse(MAPPING), ...overrides }),
        );

      // A mapping edit that touches nothing any page decided.
      mapping({ ignore: ["never/**"] });
      expect(await h.sync()).toMatchObject({
        stored: 0,
        duplicates: 0,
        errors: [],
      });
      // Reverting it is not a change either.
      mapping({});
      expect(await h.sync()).toMatchObject({
        stored: 0,
        duplicates: 0,
        errors: [],
      });
      expect(h.events()).toHaveLength(settled);

      // A change to what one page decides re-emits that page and no other.
      mapping({
        type: { field: "type", values: { Secret: "topic" }, default: "topic" },
      });
      const changed = await h.sync();
      expect(changed).toMatchObject({ stored: 1, errors: [] });
      expect(h.events().at(-1)).toMatchObject({
        id: h.mirror.name(6),
        deleted: 0,
      });
      expect(await h.sync()).toMatchObject({ stored: 0, errors: [] });
      // The revert changes that page back: one page, one event.
      mapping({});
      expect(await h.sync()).toMatchObject({ stored: 1, errors: [] });
    } finally {
      h.dispose();
    }
  });
});

describe("wiki revisions reach staging as their own claims", () => {
  test("reverting a page to earlier text files a new live claim carrying that text, and a restore files one too", async () => {
    const h = harness(KINDS[1]);
    try {
      await establish(h, 2);
      const forPage = (name: string) =>
        h.db
          .query<{ body: string; revision: number | null; status: string }, [string]>(
            `SELECT body, json_extract(frontmatter, '$."x-source-revision"') AS revision, status
               FROM claims WHERE json_extract(frontmatter, '$."x-source-record-id"') = ?
              ORDER BY created_at, claim_id`,
          )
          .all(name);
      const page = h.mirror.name(0);
      expect(forPage(page).map((claim) => [claim.body, claim.revision])).toEqual([["body 0\n", null]]);

      h.put(0, "edited");
      await h.sync();
      h.put(0);
      await h.sync();
      const revisions = forPage(page);
      expect(revisions.map((claim) => [claim.body, claim.revision])).toEqual([
        ["body 0\n", null],
        ["edited\n", 1],
        ["body 0\n", 2],
      ]);
      expect(revisions.every((claim) => claim.status === "live")).toBe(true);

      h.remove(0);
      await h.sync();
      h.put(0);
      await h.sync();
      expect(forPage(page).at(-1)).toMatchObject({ body: "body 0\n", revision: 4, status: "live" });
    } finally {
      h.dispose();
    }
  });
});

describe("wiki renames keep the page they rename", () => {
  test("ten renames stage ten claims on the pages' own targets and retract nothing", async () => {
    const h = harness(KINDS[1]);
    try {
      await establish(h, 12);
      const target = (record: string) =>
        h.db
          .query<{ target: string }, [string]>(
            `SELECT target FROM claims
              WHERE kind IN ('claim', 'entity') AND json_extract(frontmatter, '$."x-source-record-id"') = ?
              ORDER BY created_at DESC, claim_id DESC LIMIT 1`,
          )
          .get(record)?.target;
      const before = Array.from({ length: 12 }, (_, index) => target(h.mirror.name(index)));
      expect(new Set(before).size).toBe(12);
      for (let index = 0; index < 10; index += 1) {
        renameSync(
          join(h.mirror.dir, h.mirror.name(index)),
          join(h.mirror.dir, `moved-${h.mirror.name(index)}`),
        );
      }
      expect(await h.sync()).toMatchObject({ stored: 10, errors: [], withdrawn: 0, retractions_filed: 0 });
      for (let index = 0; index < 10; index += 1) {
        expect(target(`moved-${h.mirror.name(index)}`)).toBe(before[index]!);
      }
      const targets = h.db
        .query<{ n: number }, []>(
          `SELECT count(DISTINCT target) AS n FROM claims WHERE kind IN ('claim', 'entity')
            AND json_extract(frontmatter, '$."x-connector"') = '${LEGACY_WIKI_CONNECTOR_ID}'`,
        )
        .get();
      expect(targets?.n).toBe(12);
      expect(h.db.query("SELECT 1 FROM claims WHERE kind = 'deletion'").get()).toBeNull();
      expect(h.db.query("SELECT 1 FROM proposals WHERE kind = 'deletion'").get()).toBeNull();
    } finally {
      h.dispose();
    }
  });
});

describe("ingest cost", () => {
  async function drainCpu(
    kind: (typeof KINDS)[number],
    files: number,
  ): Promise<{ cpuMs: number; stored: number }> {
    const h = harness(kind);
    const listing = spyOn(filesystem, "readdir");
    try {
      for (let index = 0; index < files; index += 1) h.put(index);
      const before = process.cpuUsage();
      const result = await runToCompletion(
        h.db,
        h.mirror.connector(),
        h.mirror.id,
        SOURCE,
        "backfill",
      );
      const used = process.cpuUsage(before);
      expect(result.errors).toEqual([]);
      // A flat tree is enumerated once for this entire drain, regardless of
      // how many capture pages Core consumes. CPU alone can hide rescans.
      expect(listing).toHaveBeenCalledTimes(1);
      listing.mockRestore();
      const cpuMs = (used.user + used.system) / 1000;
      // A pass with nothing to do emits nothing.
      expect(
        await runToCompletion(
          h.db,
          h.mirror.connector(),
          h.mirror.id,
          SOURCE,
          "sync",
        ),
      ).toMatchObject({ stored: 0 });
      return { cpuMs, stored: result.stored };
    } finally {
      listing.mockRestore();
      h.dispose();
    }
  }

  for (const kind of KINDS) test(`${kind.label} 5,000-file backfill does not rescan the whole tree per batch`, async () => {
    const small = await drainCpu(kind, 1000);
    const large = await drainCpu(kind, 5000);
    expect(large.stored).toBe(5000);
    // Bound both absolute CPU and growth independently of shared-machine load.
    expect(large.cpuMs).toBeLessThan(60_000);
    // Five times the files must cost near five times the CPU, not twenty-five.
    expect(large.cpuMs / small.cpuMs).toBeLessThan(9);
  }, 120_000);
});
