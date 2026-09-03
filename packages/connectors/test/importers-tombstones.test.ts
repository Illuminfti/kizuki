import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openLedger, replay, runBackfill, runSync } from "@kizuki/core";
import type { CaptureEvent, Connector } from "@kizuki/core";
import { initStaging } from "@kizuki/core/staging";
import {
  OMNIVORE_FIXTURE_FILES,
  createOmnivoreImportConnector,
} from "../src/import-omnivore";
import {
  POCKET_FIXTURE_EXPORT,
  createPocketImportConnector,
} from "../src/import-pocket";
import {
  WHATSAPP_FIXTURE_FILES,
  WHATSAPP_FIXTURE_TIMEZONE,
  createWhatsAppImportConnector,
} from "../src/import-whatsapp";

const CHAT_FILE = "WhatsApp Chat with Acme Planning.txt";
const SOURCE_KEY = "src";

interface Scenario {
  /** Writes the whole export over the configured path. */
  full(): Promise<void>;
  /** Writes a strict subset of the same export over the same path. */
  subset(): Promise<void>;
  connector: Connector;
  connector_id: string;
  fullCount: number;
  subsetCount: number;
}

function openVault(): Database {
  const db = openLedger(":memory:");
  initStaging(db);
  return db;
}

function stored(db: Database): CaptureEvent[] {
  return [...replay(db, {})];
}

async function whatsappScenario(root: string): Promise<Scenario> {
  const chat = WHATSAPP_FIXTURE_FILES[CHAT_FILE] ?? "";
  const lines = chat.trimEnd().split("\n");
  const connector = createWhatsAppImportConnector({
    path: root,
    timezone: WHATSAPP_FIXTURE_TIMEZONE,
  });
  return {
    connector,
    connector_id: connector.manifest().connector_id,
    fullCount: 8,
    subsetCount: 3,
    full: () => writeFile(path.join(root, CHAT_FILE), chat),
    // The last three messages of the same chat, in the same file, so the
    // records that survive keep their identity.
    subset: () =>
      writeFile(path.join(root, CHAT_FILE), `${lines.slice(-3).join("\n")}\n`),
  };
}

async function pocketScenario(root: string): Promise<Scenario> {
  const file = path.join(root, "pocket.csv");
  const lines = POCKET_FIXTURE_EXPORT.trimEnd().split("\n");
  const connector = createPocketImportConnector({ path: file });
  return {
    connector,
    connector_id: connector.manifest().connector_id,
    fullCount: 4,
    subsetCount: 2,
    full: () => writeFile(file, POCKET_FIXTURE_EXPORT),
    // The fixture's second and third saves, in the order the full export
    // wrote them, so the records that survive keep their identity.
    subset: () =>
      writeFile(file, `${[lines[0], lines[2], lines[3]].join("\n")}\n`),
  };
}

async function omnivoreScenario(root: string): Promise<Scenario> {
  const metadata = JSON.parse(
    OMNIVORE_FIXTURE_FILES["metadata_0_to_3.json"] ?? "[]",
  ) as unknown[];
  const target = path.join(root, "metadata_0_to_3.json");
  for (const [name, content] of Object.entries(OMNIVORE_FIXTURE_FILES)) {
    if (name === "metadata_0_to_3.json") continue;
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const connector = createOmnivoreImportConnector({ path: root });
  return {
    connector,
    connector_id: connector.manifest().connector_id,
    fullCount: 3,
    subsetCount: 1,
    full: () => writeFile(target, JSON.stringify(metadata)),
    subset: () => writeFile(target, JSON.stringify(metadata.slice(1, 2))),
  };
}

const scenarios: {
  name: string;
  build: (root: string) => Promise<Scenario>;
}[] = [
  { name: "whatsapp", build: whatsappScenario },
  { name: "pocket", build: pocketScenario },
  { name: "omnivore", build: omnivoreScenario },
];

async function withScenario(
  build: (root: string) => Promise<Scenario>,
  body: (scenario: Scenario, db: Database) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-tombstone-"));
  const db = openVault();
  try {
    await body(await build(root), db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const { name, build } of scenarios) {
  test(`${name}: a smaller re-import stores, withdraws and retracts nothing`, async () => {
    await withScenario(build, async (scenario, db) => {
      await scenario.full();
      const first = await runBackfill(
        db,
        scenario.connector,
        scenario.connector_id,
        SOURCE_KEY,
      );
      expect(first.stored).toBe(scenario.fullCount);
      expect(first.errors).toEqual([]);
      expect(first.proposals_created).toBeGreaterThan(0);

      await scenario.subset();
      const smaller = await runSync(
        db,
        scenario.connector,
        scenario.connector_id,
        SOURCE_KEY,
      );
      expect(smaller).toEqual({
        stored: 0,
        duplicates: scenario.subsetCount,
        errors: [],
        proposals_created: 0,
        withdrawn: 0,
        retractions_filed: 0,
        cursor: null,
      });

      const rows = stored(db);
      expect(rows.length).toBe(scenario.fullCount);
      expect(rows.some((event) => event.deleted)).toBe(false);

      await scenario.full();
      const again = await runSync(
        db,
        scenario.connector,
        scenario.connector_id,
        SOURCE_KEY,
      );
      expect(again.stored).toBe(0);
      expect(again.duplicates).toBe(scenario.fullCount);
      expect(stored(db).length).toBe(scenario.fullCount);
    });
  });

  test(`${name}: a larger re-import stores only what is new`, async () => {
    await withScenario(build, async (scenario, db) => {
      await scenario.subset();
      const small = await runBackfill(
        db,
        scenario.connector,
        scenario.connector_id,
        SOURCE_KEY,
      );
      expect(small.stored).toBe(scenario.subsetCount);
      const overlapping = stored(db).map((event) => event.source_record_id);

      await scenario.full();
      const large = await runSync(
        db,
        scenario.connector,
        scenario.connector_id,
        SOURCE_KEY,
      );
      expect(large.stored).toBe(scenario.fullCount - scenario.subsetCount);
      expect(large.duplicates).toBe(scenario.subsetCount);
      expect(large.withdrawn).toBe(0);
      expect(large.retractions_filed).toBe(0);

      const ids = stored(db).map((event) => event.source_record_id);
      for (const id of overlapping) {
        expect(ids).toContain(id);
      }
      expect(ids.length).toBe(scenario.fullCount);
    });
  });
}

test("a file appearing beside an export does not fork the message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-tombstone-"));
  const db = openVault();
  try {
    await writeFile(
      path.join(root, CHAT_FILE),
      "1/4/26, 9:20 AM - Ada: IMG-1.jpg (file attached)\n",
    );
    const connector = createWhatsAppImportConnector({
      path: root,
      timezone: WHATSAPP_FIXTURE_TIMEZONE,
      date_order: "mdy",
    });
    const id = connector.manifest().connector_id;

    // The media folder was not copied in yet: the message imports with no
    // attachment, exactly as a "without media" export would.
    expect((await runBackfill(db, connector, id, SOURCE_KEY)).stored).toBe(1);
    expect(stored(db)[0]?.attachments).toEqual([]);

    // A message is what it says. Which files sit beside the chat is not part
    // of it, so copying the media in — or pruning it — re-stores nothing.
    await writeFile(path.join(root, "IMG-1.jpg"), "fixture-bytes");
    const again = await runSync(db, connector, id, SOURCE_KEY);
    expect(again).toMatchObject({
      stored: 0,
      duplicates: 1,
      withdrawn: 0,
      retractions_filed: 0,
    });
    expect(stored(db).length).toBe(1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a content file appearing later does not fork the item", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-tombstone-"));
  const db = openVault();
  try {
    await writeFile(
      path.join(root, "metadata_0_to_9.json"),
      JSON.stringify([
        { id: "one", slug: "one", savedAt: "2026-01-01T09:00:00Z" },
      ]),
    );
    const connector = createOmnivoreImportConnector({ path: root });
    const id = connector.manifest().connector_id;

    expect((await runBackfill(db, connector, id, SOURCE_KEY)).stored).toBe(1);
    expect(stored(db)[0]?.attachments).toEqual([]);

    await mkdir(path.join(root, "content"));
    await writeFile(path.join(root, "content", "one.html"), "<p>saved</p>");
    const again = await runSync(db, connector, id, SOURCE_KEY);
    expect(again).toMatchObject({ stored: 0, duplicates: 1 });
    expect(stored(db).length).toBe(1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an edited record is a new version, never a deletion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-tombstone-"));
  const db = openVault();
  try {
    const file = path.join(root, "pocket.csv");
    const header = "title,url,time_added,tags,status";
    const row = (status: string): string =>
      `${header}\nA title,https://example.com/a,1767225600,notes,${status}\n`;
    const connector = createPocketImportConnector({ path: file });
    const id = connector.manifest().connector_id;

    await writeFile(file, row("unread"));
    expect((await runBackfill(db, connector, id, SOURCE_KEY)).stored).toBe(1);

    await writeFile(file, row("archive"));
    const edited = await runSync(db, connector, id, SOURCE_KEY);
    expect(edited.stored).toBe(1);
    expect(edited.withdrawn).toBe(0);
    expect(edited.retractions_filed).toBe(0);

    const rows = stored(db);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((event) => event.source_record_id)).size).toBe(1);
    expect(new Set(rows.map((event) => event.content_hash)).size).toBe(2);
    expect(rows.map((event) => event.metadata["status"]).sort()).toEqual([
      "archive",
      "unread",
    ]);
    expect(rows.some((event) => event.deleted)).toBe(false);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a repeat's number is a position, and a subset renumbers it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-tombstone-"));
  const db = openVault();
  try {
    // A repeated url is numbered by where it sits in the export, which is the
    // only thing the file offers: the two saves are otherwise the same record
    // saved twice. An export that dropped the earlier save therefore hands the
    // bare id to the later one, which the ledger keeps as another version of
    // that record. Nothing is deleted, withdrawn or retracted; there is one
    // extra row. This is the documented edge of "a smaller export stores
    // nothing", and the page states it for both importers that number repeats.
    const file = path.join(root, "pocket.csv");
    const lines = POCKET_FIXTURE_EXPORT.trimEnd().split("\n");
    const connector = createPocketImportConnector({ path: file });
    const id = connector.manifest().connector_id;

    await writeFile(file, POCKET_FIXTURE_EXPORT);
    expect((await runBackfill(db, connector, id, SOURCE_KEY)).stored).toBe(4);
    expect(stored(db).map((event) => event.source_record_id)).toContain(
      "https://example.com/heron#2",
    );

    // The later of the two saves of one url, alone.
    await writeFile(file, `${[lines[0], lines[4]].join("\n")}\n`);
    const smaller = await runSync(db, connector, id, SOURCE_KEY);
    expect(smaller).toMatchObject({
      stored: 1,
      duplicates: 0,
      withdrawn: 0,
      retractions_filed: 0,
    });

    const rows = stored(db);
    expect(rows.length).toBe(5);
    expect(rows.some((event) => event.deleted)).toBe(false);
    // The row the full export stored under the bare id is untouched: the new
    // one is a version beside it, not a replacement of it.
    expect(
      rows.filter(
        (event) => event.source_record_id === "https://example.com/heron",
      ).length,
    ).toBe(2);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
