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
  getConnector,
  runConformance,
  seedFixtureDatabase,
} from "../src";
import type { Connector, Sensitivity } from "@kizuki/core";

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
    ]);

    expect(results).toEqual([
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

test("a manifest without sensitivity defaults fails closed", async () => {
  const base = getConnector(CHATGPT_IMPORT_CONNECTOR_ID, {
    path: "fixture.json",
  });
  const {
    default_sensitivity: _default,
    sensitivity_floor: _floor,
    ...withoutSensitivity
  } = base.manifest();
  const undeclared: Connector = {
    ...base,
    manifest: () => withoutSensitivity as ReturnType<Connector["manifest"]>,
  };
  const result = await runConformance(undeclared);
  expect(result.pass).toBe(false);
  expect(result.failures).toEqual([
    "manifest.default_sensitivity: must be one of public | personal | private",
    "manifest.sensitivity_floor: must be one of public | personal | private",
  ]);
});

test("a manifest with an unknown sensitivity level fails closed", async () => {
  const base = getConnector(CHATGPT_IMPORT_CONNECTOR_ID, {
    path: "fixture.json",
  });
  // Widened so the invalid level survives to the runtime check the manifest
  // parser performs on a manifest the type system never saw.
  const level: string = "secret";
  const invalid: Connector = {
    ...base,
    manifest: () => ({
      ...base.manifest(),
      default_sensitivity: level as Sensitivity,
    }),
  };
  const result = await runConformance(invalid);
  expect(result.pass).toBe(false);
  expect(result.failures).toContain(
    "manifest.default_sensitivity: must be one of public | personal | private",
  );
});
