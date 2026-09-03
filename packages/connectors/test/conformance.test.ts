import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHATGPT_FIXTURE_EXPORT,
  CHATGPT_IMPORT_CONNECTOR_ID,
  CLAUDE_FIXTURE_EXPORT,
  CLAUDE_IMPORT_CONNECTOR_ID,
  ICS_CONNECTOR_ID,
  IMAP_CONNECTOR_ID,
  LEGACY_EVENTS_CONNECTOR_ID,
  LEGACY_EVENTS_FIXTURE,
  LEGACY_WIKI_CONNECTOR_ID,
  LEGACY_WIKI_FIXTURE,
  MARKDOWN_FOLDER_CONNECTOR_ID,
  OMNIVORE_FIXTURE_FILES,
  OMNIVORE_IMPORT_CONNECTOR_ID,
  POCKET_FIXTURE_EXPORT,
  POCKET_IMPORT_CONNECTOR_ID,
  REGISTRY,
  SCREENPIPE_CONNECTOR_ID,
  TELEGRAM_CONNECTOR_ID,
  TelegramConnector,
  WHATSAPP_FIXTURE_FILES,
  WHATSAPP_FIXTURE_TIMEZONE,
  WHATSAPP_IMPORT_CONNECTOR_ID,
  createIcsConnector,
  createImapConnector,
  getConnector,
  runConformance,
  scriptedDeps,
  seedFixtureDatabase,
} from "../src";
import type { ConformanceResult } from "../src";
import { fixtureJsonl as jsonlFixture } from "../src/import-legacy-events/fixture";
import { encodeState } from "@kizuki/connector-telegram";
import type { Connector } from "@kizuki/core";
import {
  FakeImapServer,
  fixtureMailbox,
  fixtureState,
  memoryDialer,
} from "@kizuki/connector-imap/testing";
import {
  FIXTURE_ICS,
  memoryFetcher,
  okResult,
} from "@kizuki/connector-ics/testing";

const TELEGRAM_STATE_REF = "file:connections/01JJ0000000000000000000000.state";

interface Layout {
  markdown: string;
  chatGpt: string;
  claude: string;
  screenpipe: string;
  whatsapp: string;
  pocket: string;
  omnivore: string;
  ics: string;
  wiki: string;
  removedWikiPage: string;
  eventsDb: string;
  eventsJsonl: string;
  deletedMarkdown: string;
}

function layoutFor(root: string): Layout {
  return {
    markdown: path.join(root, "markdown"),
    chatGpt: path.join(root, "chatgpt.json"),
    claude: path.join(root, "claude.json"),
    screenpipe: path.join(root, "screenpipe.sqlite"),
    whatsapp: path.join(root, "whatsapp"),
    pocket: path.join(root, "pocket.csv"),
    omnivore: path.join(root, "omnivore"),
    ics: path.join(root, "team.ics"),
    wiki: path.join(root, "wiki"),
    removedWikiPage: path.join(root, "wiki", "notes", "plan.md"),
    eventsDb: path.join(root, "legacy.db"),
    eventsJsonl: path.join(root, "legacy.jsonl"),
    deletedMarkdown: path.join(root, "markdown", "delete-me.md"),
  };
}

/** The ICS fixture without its attachment event, used to prove a tombstone. */
const ICS_WITHOUT_ATTACHMENT = FIXTURE_ICS.replace(
  [
    "BEGIN:VEVENT",
    "UID:attach-1@acme.example",
    "DTSTAMP:20260201T000000Z",
    "DTSTART:20260306T090000Z",
    "DTEND:20260306T093000Z",
    "ATTACH;FMTTYPE=application/pdf:https://files.acme.example/agenda.pdf",
    "SUMMARY:Board prep",
    "END:VEVENT",
    "",
  ].join("\r\n"),
  "",
);

function combine(results: ConformanceResult[]): ConformanceResult {
  return {
    pass: results.every((result) => result.pass),
    failures: results.flatMap((result) => result.failures),
  };
}

/**
 * One entry per registry id, so the coverage test below proves the suite
 * exercises the whole registry rather than a hand-counted subset of it.
 * Connectors that sign in build their fixture peer inside the thunk.
 */
function batteryFor(
  layout: Layout,
): Record<string, () => Promise<ConformanceResult>> {
  const markdown = getConnector(MARKDOWN_FOLDER_CONNECTOR_ID, {
    path: layout.markdown,
  });
  const plain = (connector: Connector) => () => runConformance(connector);
  return {
    [MARKDOWN_FOLDER_CONNECTOR_ID]: () =>
      runConformance(markdown, {
        tombstone: {
          prepare: async () => (await markdown.backfill(null)).cursor,
          mutate: async () => unlink(layout.deletedMarkdown),
        },
      }),
    [CHATGPT_IMPORT_CONNECTOR_ID]: plain(
      getConnector(CHATGPT_IMPORT_CONNECTOR_ID, { path: layout.chatGpt }),
    ),
    [CLAUDE_IMPORT_CONNECTOR_ID]: plain(
      getConnector(CLAUDE_IMPORT_CONNECTOR_ID, { path: layout.claude }),
    ),
    [SCREENPIPE_CONNECTOR_ID]: plain(
      getConnector(SCREENPIPE_CONNECTOR_ID, {
        path: layout.screenpipe,
        settle_seconds: 0,
      }),
    ),
    [WHATSAPP_IMPORT_CONNECTOR_ID]: plain(
      getConnector(WHATSAPP_IMPORT_CONNECTOR_ID, {
        path: layout.whatsapp,
        // Pinned so the double backfill is identical on any host.
        timezone: WHATSAPP_FIXTURE_TIMEZONE,
      }),
    ),
    [POCKET_IMPORT_CONNECTOR_ID]: plain(
      getConnector(POCKET_IMPORT_CONNECTOR_ID, { path: layout.pocket }),
    ),
    [OMNIVORE_IMPORT_CONNECTOR_ID]: plain(
      getConnector(OMNIVORE_IMPORT_CONNECTOR_ID, { path: layout.omnivore }),
    ),
    [TELEGRAM_CONNECTOR_ID]: async () => {
      const telegram = new TelegramConnector(
        { state_ref: TELEGRAM_STATE_REF },
        scriptedDeps(),
      );
      await telegram.connect(async (ref) => {
        expect(ref).toBe(TELEGRAM_STATE_REF);
        return new TextDecoder().decode(
          encodeState({
            schema: "kizuki.telegram-state/v1",
            user_id: "1001",
            session: "fixture-session-token-not-a-real-credential",
          }),
        );
      });
      return runConformance(telegram);
    },
    [IMAP_CONNECTOR_ID]: async () => {
      const imapServer = new FakeImapServer(fixtureMailbox(), {
        username: fixtureState().username,
        password: fixtureState().password,
      });
      const imap = createImapConnector(
        { secret_ref: "file:connections/01ABCDEFGHJKMNPQRSTVWXYZ00.state" },
        { dial: memoryDialer(imapServer) },
      );
      await imap.connect(async () => JSON.stringify(fixtureState()));
      return runConformance(imap, {
        tombstone: {
          prepare: async () => (await imap.backfill(null)).cursor,
          mutate: async () => {
            imapServer.expunge("INBOX", 1);
          },
        },
      });
    },
    [ICS_CONNECTOR_ID]: async () => {
      const icsFile = createIcsConnector({ path: layout.ics });
      const icsUrl = "https://calendar.acme.example/private/abc123.ics";
      let icsRoute = FIXTURE_ICS;
      const icsRemote = createIcsConnector(
        { secret_ref: "file:connections/01ABCDEFGHJKMNPQRSTVWXYZ01.state" },
        { fetch: memoryFetcher({ [icsUrl]: () => okResult(icsRoute) }) },
      );
      await icsRemote.connect(async () =>
        JSON.stringify({ schema: "kizuki.ics-state/v1", url: icsUrl }),
      );
      const fileResult = await runConformance(icsFile, {
        tombstone: {
          prepare: async () => (await icsFile.backfill(null)).cursor,
          mutate: async () => {
            await writeFile(layout.ics, ICS_WITHOUT_ATTACHMENT);
          },
        },
      });
      const remoteResult = await runConformance(icsRemote, {
        tombstone: {
          prepare: async () => (await icsRemote.backfill(null)).cursor,
          mutate: async () => {
            icsRoute = ICS_WITHOUT_ATTACHMENT;
          },
        },
      });
      return combine([fileResult, remoteResult]);
    },
    [LEGACY_WIKI_CONNECTOR_ID]: async () => {
      const wiki = getConnector(LEGACY_WIKI_CONNECTOR_ID, { path: layout.wiki });
      return runConformance(wiki, {
        tombstone: {
          prepare: async () => (await wiki.backfill(null)).cursor,
          mutate: async () => unlink(layout.removedWikiPage),
        },
      });
    },
    [LEGACY_EVENTS_CONNECTOR_ID]: async () => {
      const eventsDb = getConnector(LEGACY_EVENTS_CONNECTOR_ID, {
        path: layout.eventsDb,
      });
      const eventsJsonl = getConnector(LEGACY_EVENTS_CONNECTOR_ID, {
        path: layout.eventsJsonl,
      });
      const dbResult = await runConformance(eventsDb, {
        tombstone: {
          prepare: async () => {
            let cursor: string | null = null;
            for (let page = 0; page < 20; page += 1) {
              const batch = await eventsDb.backfill(cursor);
              cursor = batch.cursor;
              if (batch.events.length === 0) break;
            }
            return cursor;
          },
          mutate: async () => {
            const db = new Database(layout.eventsDb);
            db.exec(
              "INSERT INTO events (id, type, ts, subject, body, is_deleted) VALUES ('r99', 'msg', 1767226380, 'Gone', 'Removed at the source.', 1)",
            );
            db.close();
          },
        },
      });
      const jsonlResult = await runConformance(eventsJsonl, {
        tombstone: {
          prepare: async () => (await eventsJsonl.backfill(null)).cursor,
          mutate: async () =>
            appendFile(
              layout.eventsJsonl,
              `${JSON.stringify({
                id: "r99",
                type: "msg",
                ts: 1_767_226_380,
                subject: "Gone",
                body: "Removed at the source.",
                is_deleted: 1,
              })}\n`,
            ),
        },
      });
      return combine([dbResult, jsonlResult]);
    },
  };
}

async function seedExports(layout: Layout): Promise<void> {
  await mkdir(path.join(layout.markdown, "nested"), { recursive: true });
  await mkdir(layout.whatsapp, { recursive: true });
  await Promise.all([
    writeFile(path.join(layout.markdown, "one.md"), "# One\n"),
    writeFile(path.join(layout.markdown, "nested", "two.md"), "# Two\n"),
    writeFile(layout.deletedMarkdown, "# Delete me\n"),
    writeFile(layout.chatGpt, JSON.stringify(CHATGPT_FIXTURE_EXPORT)),
    writeFile(layout.claude, JSON.stringify(CLAUDE_FIXTURE_EXPORT)),
    writeFile(layout.pocket, POCKET_FIXTURE_EXPORT),
    writeFile(layout.ics, FIXTURE_ICS),
  ]);
  const screenpipeFixture = new Database(layout.screenpipe);
  seedFixtureDatabase(screenpipeFixture);
  screenpipeFixture.close();
  for (const [name, content] of Object.entries(WHATSAPP_FIXTURE_FILES)) {
    await writeFile(path.join(layout.whatsapp, name), content);
  }
  for (const [name, content] of Object.entries(OMNIVORE_FIXTURE_FILES)) {
    const target = path.join(layout.omnivore, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  for (const file of LEGACY_WIKI_FIXTURE.files) {
    const target = path.join(layout.wiki, file.relpath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  await writeFile(
    path.join(layout.wiki, "kizuki-mapping.json"),
    JSON.stringify(LEGACY_WIKI_FIXTURE.mapping),
  );
  const eventsDb = new Database(layout.eventsDb);
  eventsDb.exec(LEGACY_EVENTS_FIXTURE.sql);
  eventsDb.close();
  await writeFile(
    `${layout.eventsDb}.kizuki-mapping.json`,
    JSON.stringify(LEGACY_EVENTS_FIXTURE.mapping),
  );
  await writeFile(layout.eventsJsonl, jsonlFixture());
  await writeFile(
    `${layout.eventsJsonl}.kizuki-mapping.json`,
    JSON.stringify({ ...LEGACY_EVENTS_FIXTURE.mapping, table: null }),
  );
}

test("all registry connectors pass conformance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-conformance-"));
  try {
    const layout = layoutFor(root);
    await seedExports(layout);
    const battery = batteryFor(layout);
    const ids = Object.keys(battery);
    const results = await Promise.all(ids.map((id) => battery[id]?.()));
    expect(results).toEqual(ids.map(() => ({ pass: true, failures: [] })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the conformance battery covers every registry entry", () => {
  const battery = batteryFor(layoutFor("/nonexistent"));
  expect(Object.keys(battery).sort()).toEqual(Object.keys(REGISTRY).sort());
});

test("a tombstones:true connector without hooks supplied fails, not skips", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-conformance-"));
  try {
    await writeFile(path.join(root, "one.md"), "# One\n");
    const result = await runConformance(
      getConnector(MARKDOWN_FOLDER_CONNECTOR_ID, { path: root }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual([
      "tombstones capability declared but no tombstone hooks were supplied to the suite",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required_secrets rejects malformed references", async () => {
  const base = getConnector(CHATGPT_IMPORT_CONNECTOR_ID, {
    path: "fixture.json",
  });
  const malformed: Connector = {
    ...base,
    manifest: () => ({
      ...base.manifest(),
      required_secrets: ["ordinary-plaintext-token"],
    }),
  };
  const result = await runConformance(malformed);
  expect(result.pass).toBe(false);
  expect(result.failures).toContain(
    "manifest.required_secrets: must contain secret_ref URIs",
  );
});

test("the registry builds the interactive telegram connector", () => {
  const connector = getConnector(TELEGRAM_CONNECTOR_ID, {});
  const manifest = connector.manifest();
  expect(manifest.connector_id).toBe("kizuki.telegram");
  expect(manifest.auth_modes).toEqual(["sign_in"]);
  expect(typeof connector.signIn).toBe("function");
  expect(manifest.required_secrets).toEqual([]);
});
