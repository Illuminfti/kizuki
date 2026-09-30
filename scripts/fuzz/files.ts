import { mkdirSync, writeFileSync, symlinkSync, truncateSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { KizukiError } from "../../packages/core/src/index";
import { createMarkdownFolderConnector, MAX_PACK_DECODED_BYTES } from "../../packages/connectors/src/markdown-folder";
import { scanLegacyWiki } from "../../packages/connectors/src/import-legacy-wiki/scan";
import { parseLegacyFrontmatter } from "../../packages/connectors/src/import-legacy-wiki/frontmatter";
import { openSqliteSource, openJsonlSource } from "../../packages/connectors/src/import-legacy-events/source";
import { createClaudeCodeSessionsConnector, createCodexSessionsConnector } from "../../packages/connector-agent-sessions/src/connector";
import { scanArchive, MAX_ACCOUNT_BYTES } from "../../packages/connector-x/src/archive";
import { checkEvents, NOW } from "./parsers";
import type { FuzzCase } from "./cases";

export const FILE_TARGETS = ["markdown-files", "wiki-files", "session-files-claude", "session-files-codex", "legacy-jsonl", "legacy-sqlite", "x-archive"] as const;
export type FileTarget = typeof FILE_TARGETS[number];

/** Fresh tree per case; every path is inside the supervisor's private scratch root. */
export async function fileCase(target: FileTarget, input: FuzzCase, scratch: string): Promise<void> {
  const tree = join(scratch, "tree");
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { mode: 0o700 });
  const outside = join(scratch, "outside.md");
  writeFileSync(outside, "outside-canary", { mode: 0o600 });
  if (target === "x-archive") {
    mkdirSync(join(tree, "data"));
    const account = join(tree, "data/account.js");
    writeFileSync(account, 'window.YTD.account.part0 = [{"account":{"accountId":"1","username":"example"}}];');
    const tweets = join(tree, "data/tweets.js");
    writeFileSync(tweets, input.id === "object" ? 'window.YTD.tweets.part0 = [];': input.bytes);
    if (input.id === "huge-line") truncateSync(account, MAX_ACCOUNT_BYTES + 1);
    if (input.id === "traversal") {
      rmSync(tweets);
      symlinkSync(outside, tweets);
    }
    try {
      const result = await scanArchive(tree);
      if (input.id === "traversal" || input.id === "huge-line") throw new Error("symlink-admitted");
      if (result.total_posts > 100_000) throw new Error("output-unbounded");
    } catch (error) {
      if (!(error instanceof KizukiError)) throw error;
    }
    return;
  }
  if (target === "legacy-sqlite") {
    const file = join(tree, "synthetic.sqlite");
    writeFileSync(file, input.bytes);
    let source;
    try {
      source = openSqliteSource(file, "events");
      source.read(0n, 100);
    } catch (error) {
      if (!(error instanceof KizukiError)) throw error;
    } finally { source?.close(); }
    return;
  }
  if (target === "legacy-jsonl") {
    const file = join(tree, "synthetic.jsonl");
    writeFileSync(file, Buffer.concat([input.bytes, Buffer.from('\n{"text":"after"}\n')]));
    if (input.id === "traversal") {
      const linked = join(tree, "link.jsonl");
      symlinkSync(file, linked);
      let linkedSource;
      try { linkedSource = openJsonlSource(linked); throw new Error("symlink-admitted"); }
      catch (error) { if (!(error instanceof KizukiError)) throw error; }
      finally { linkedSource?.close(); }
    }
    const source = openJsonlSource(file);
    try {
      let after = 0n, found = false;
      for (let page = 0; page < 1000; page += 1) {
        const rows = source.read(after, 100);
        if (rows.length > 100) throw new Error("output-unbounded");
        if (rows.length === 0) break;
        for (const row of rows) {
          if (row.position <= after) throw new Error("resume-lost");
          after = row.position;
          if (row.values?.["text"] === "after") found = true;
        }
        if (found) break;
      }
      if (!found) throw new Error("resume-lost");
    } finally { source.close(); }
    return;
  }
  const sessions = target.startsWith("session-files");
  const suffix = sessions ? "jsonl" : "md";
  const file = join(tree, `synthetic.${suffix}`);
  writeFileSync(file, input.bytes);
  symlinkSync(outside, join(tree, `link.${suffix}`));
  symlinkSync(tree, join(tree, "cycle"));
  if (input.id === "huge-line") {
    // Sparse file checks stat refusal without allocating its claimed size.
    writeFileSync(join(tree, `oversized.${suffix}`), "");
    truncateSync(join(tree, `oversized.${suffix}`), sessions ? 512 * 1024 * 1024 + 1 : 4 * 1024 * 1024 + 1);
  }
  if (target === "wiki-files") {
    const result = await scanLegacyWiki(tree, []);
    if (result.files.some(file => file.relpath.includes("link") || file.content.includes("outside-canary"))) throw new Error("symlink-admitted");
    if (input.id.startsWith("invalid-utf8") && !result.skipped.some(item => item.reason === "not_utf8")) throw new Error("invalid-encoding-admitted");
    for (const file of result.files) parseLegacyFrontmatter(file.content);
    return;
  }
  const connector = target === "markdown-files" ? createMarkdownFolderConnector({ path: tree })
    : target === "session-files-claude" ? createClaudeCodeSessionsConnector({ path: tree }) : createCodexSessionsConnector({ path: tree });
  let batch;
  try { batch = await connector.backfill(null); }
  catch (error) {
    if (target === "markdown-files" && error instanceof KizukiError && (input.id.startsWith("invalid-utf8") || input.id === "huge-line")) return;
    throw error;
  }
  checkEvents(batch.events);
  if (batch.events.some(event => event.text.includes("outside-canary") || event.source_record_id.includes("link"))) throw new Error("symlink-admitted");
  if (target === "markdown-files" && input.id === "object" && batch.cursor !== null) {
    const cursor = JSON.parse(batch.cursor) as Record<string, unknown>;
    delete cursor["files"];
    cursor["pack"] = Buffer.from(gzipSync(Buffer.from(" ".repeat(MAX_PACK_DECODED_BYTES + 1)))).toString("base64");
    try { await connector.backfill(JSON.stringify(cursor)); throw new Error("archive-expansion-admitted"); }
    catch (error) { if (!(error instanceof KizukiError)) throw error; }
  }
}
