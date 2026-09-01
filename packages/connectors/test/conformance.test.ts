import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHATGPT_FIXTURE_EXPORT,
  CHATGPT_IMPORT_CONNECTOR_ID,
  CLAUDE_FIXTURE_EXPORT,
  CLAUDE_IMPORT_CONNECTOR_ID,
  MARKDOWN_FOLDER_CONNECTOR_ID,
  getConnector,
  runConformance,
} from "../src";

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
    ]);

    expect(results).toEqual([
      { pass: true, failures: [] },
      { pass: true, failures: [] },
      { pass: true, failures: [] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
