import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHATGPT_FIXTURE_EXPORT,
  CHATGPT_IMPORT_CONNECTOR_ID,
  CLAUDE_FIXTURE_EXPORT,
  CLAUDE_IMPORT_CONNECTOR_ID,
  ICS_CONNECTOR_ID,
  IMAP_CONNECTOR_ID,
  MARKDOWN_FOLDER_CONNECTOR_ID,
  OMNIVORE_FIXTURE_FILES,
  OMNIVORE_IMPORT_CONNECTOR_ID,
  POCKET_FIXTURE_EXPORT,
  POCKET_IMPORT_CONNECTOR_ID,
  REGISTRY,
  SCREENPIPE_CONNECTOR_ID,
  TELEGRAM_CONNECTOR_ID,
  TelegramConnector,
  createIcsConnector,
  createImapConnector,
  WHATSAPP_FIXTURE_FILES,
  WHATSAPP_FIXTURE_TIMEZONE,
  WHATSAPP_IMPORT_CONNECTOR_ID,
  getConnector,
  runConformance,
  scriptedDeps,
  seedFixtureDatabase,
  REGISTRY,
} from "../src";
import { encodeState } from "@kizuki/connector-telegram";
import type { ConformanceResult } from "../src";
import type { Connector } from "@kizuki/core";
import {
  FakeImapServer,
  fixtureMailbox,
  fixtureState,
  memoryDialer,
} from "@kizuki/connector-imap/testing";
import { FIXTURE_ICS, memoryFetcher, okResult } from "@kizuki/connector-ics/testing";

const REGISTRY_IDS = Object.keys(REGISTRY);

const TELEGRAM_STATE_REF = "file:connections/01JJ0000000000000000000000.state";

interface Layout {
  markdown: string;
  chatGpt: string;
  claude: string;
  screenpipe: string;
  whatsapp: string;
  pocket: string;
  omnivore: string;
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
    deletedMarkdown: path.join(root, "markdown", "delete-me.md"),
  };
}

/**
 * One entry per registry id, so the coverage test below proves the suite
 * exercises the whole registry rather than a hand-counted subset of it.
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
}

test("all registry connectors pass conformance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-conformance-"));
  try {
    const markdownRoot = path.join(root, "markdown");
    await mkdir(path.join(markdownRoot, "nested"), { recursive: true });
    const deletedPath = path.join(markdownRoot, "delete-me.md");
    await Promise.all([
      writeFile(path.join(markdownRoot, "one.md"), "# One\n"),
      writeFile(path.join(markdownRoot, "nested", "two.md"), "# Two\n"),
      writeFile(deletedPath, "# Delete me\n"),
    ]);

    const chatGptPath = path.join(root, "chatgpt.json");
    const claudePath = path.join(root, "claude.json");
    await Promise.all([
      writeFile(chatGptPath, JSON.stringify(CHATGPT_FIXTURE_EXPORT)),
      writeFile(claudePath, JSON.stringify(CLAUDE_FIXTURE_EXPORT)),
    ]);
    const screenpipePath = path.join(root, "screenpipe.sqlite");
    const screenpipeFixture = new Database(screenpipePath);
    seedFixtureDatabase(screenpipeFixture);
    screenpipeFixture.close();

    const icsPath = path.join(root, "team.ics");
    const icsWithout = FIXTURE_ICS.replace(
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
    await writeFile(icsPath, FIXTURE_ICS);

    const imapServer = new FakeImapServer(fixtureMailbox(), {
      username: fixtureState().username,
      password: fixtureState().password,
    });
    const imap = createImapConnector(
      { secret_ref: "file:connections/01ABCDEFGHJKMNPQRSTVWXYZ00.state" },
      { dial: memoryDialer(imapServer) },
    );
    await imap.connect(async () => JSON.stringify(fixtureState()));

    const icsFile = createIcsConnector({ path: icsPath });
    const icsUrl = "https://calendar.acme.example/private/abc123.ics";
    let icsRoute = FIXTURE_ICS;
    const icsRemote = createIcsConnector(
      { secret_ref: "file:connections/01ABCDEFGHJKMNPQRSTVWXYZ01.state" },
      {
        fetch: memoryFetcher({ [icsUrl]: () => okResult(icsRoute) }),
      },
    );
    await icsRemote.connect(async () =>
      JSON.stringify({ schema: "kizuki.ics-state/v1", url: icsUrl }),
    );

    const markdown = getConnector(MARKDOWN_FOLDER_CONNECTOR_ID, {
      path: markdownRoot,
    });
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
    const results = await Promise.all([
      runConformance(markdown, {
        tombstone: {
          prepare: async () => (await markdown.backfill(null)).cursor,
          mutate: async () => unlink(deletedPath),
        },
      }),
      runConformance(
        getConnector(CHATGPT_IMPORT_CONNECTOR_ID, { path: chatGptPath }),
      ),
      runConformance(
        getConnector(CLAUDE_IMPORT_CONNECTOR_ID, { path: claudePath }),
      ),
      runConformance(
        getConnector(SCREENPIPE_CONNECTOR_ID, {
          path: screenpipePath,
          settle_seconds: 0,
        }),
      ),
      runConformance(telegram),
      runConformance(imap, {
        tombstone: {
          prepare: async () => (await imap.backfill(null)).cursor,
          mutate: async () => {
            imapServer.expunge("INBOX", 1);
          },
        },
      }),
      runConformance(icsFile, {
        tombstone: {
          prepare: async () => (await icsFile.backfill(null)).cursor,
          mutate: async () => {
            await writeFile(icsPath, icsWithout);
          },
        },
      }),
      runConformance(icsRemote, {
        tombstone: {
          prepare: async () => (await icsRemote.backfill(null)).cursor,
          mutate: async () => {
            icsRoute = icsWithout;
          },
        },
      }),
    ]);

    expect(results).toEqual([
      { pass: true, failures: [] },
      { pass: true, failures: [] },
      { pass: true, failures: [] },
      { pass: true, failures: [] },
      { pass: true, failures: [] },
      { pass: true, failures: [] },
      { pass: true, failures: [] },
      { pass: true, failures: [] },
    ]);
    expect(REGISTRY_IDS).toContain(IMAP_CONNECTOR_ID);
    expect(REGISTRY_IDS).toContain(ICS_CONNECTOR_ID);
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
