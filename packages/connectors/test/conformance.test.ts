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
  MARKDOWN_FOLDER_CONNECTOR_ID,
  SCREENPIPE_CONNECTOR_ID,
  TELEGRAM_CONNECTOR_ID,
  TelegramConnector,
  getConnector,
  runConformance,
  scriptedDeps,
  seedFixtureDatabase,
} from "../src";
import { encodeState } from "@kizuki/connector-telegram";
import type { Connector } from "@kizuki/core";

const TELEGRAM_STATE_REF = "file:connections/01JJ0000000000000000000000.state";

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
    ]);

    expect(results).toEqual([
      { pass: true, failures: [] },
      { pass: true, failures: [] },
      { pass: true, failures: [] },
      { pass: true, failures: [] },
      { pass: true, failures: [] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  const base = getConnector(CHATGPT_IMPORT_CONNECTOR_ID, { path: "fixture.json" });
  const malformed: Connector = {
    ...base,
    manifest: () => ({ ...base.manifest(), required_secrets: ["ordinary-plaintext-token"] }),
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
