import { expect, test } from "bun:test";
import { appendFile, rename, truncate, writeFile } from "node:fs/promises";
import { MAX_CURSOR_BYTES } from "@kizuki/core";
import { MAX_CURSOR_STORE_BYTES, MAX_CURSOR_STORE_ENTRIES } from "@kizuki/core/contracts";
import type { Connector, Cursor, RunContext } from "@kizuki/core";
import { InMemoryLedger } from "../../connectors/src/testkit";
import { createClaudeCodeSessionsConnector, createCodexSessionsConnector } from "../src";
import { openSessionFile } from "../src/files";
import { claudeTurn, codexMeta, codexTurn, tempRoot, texts, writeJsonl } from "./helpers";

/** Simulates only committed host batches; a new connector instance sees the same map. */
function host() {
  const store = new Map<string, string>();
  let cursor: Cursor | null = null;
  return {
    store,
    async pass(connector: Connector) {
      const events = [];
      for (let page = 0; page < 1000; page++) {
        const batch = await connector.sync(cursor, { cursor_store: store } satisfies RunContext);
        events.push(...batch.events);
        cursor = batch.cursor;
        for (const [key, value] of Object.entries(batch.cursor_store ?? {})) {
          if (value === null) store.delete(key); else store.set(key, value);
        }
        expect(Buffer.byteLength(cursor ?? "")).toBeLessThanOrEqual(MAX_CURSOR_BYTES);
        expect(store.size).toBeLessThanOrEqual(MAX_CURSOR_STORE_ENTRIES);
        expect([...store].reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0)).toBeLessThanOrEqual(MAX_CURSOR_STORE_BYTES);
        if (batch.has_more !== true) return events;
      }
      throw new Error("pass did not finish");
    },
  };
}

test("a 20 MiB growing transcript reads only appended bytes and bounded identity bytes after restart", async () => {
  const root = await tempRoot();
  const file = await writeJsonl(root, "large.jsonl", [claudeTurn("first", "first"), ...Array.from({ length: 20 }, () => JSON.stringify({ type: "progress", padding: "x".repeat(1024 * 1024) }))]);
  let readBytes = 0;
  const openFile: typeof openSessionFile = async (name) => {
    const opened = await openSessionFile(name);
    if ("handle" in opened) {
      const read = opened.handle.read.bind(opened.handle);
      opened.handle.read = (async (...args: Parameters<typeof read>) => {
        const result = await read(...args);
        readBytes += result.bytesRead;
        return result;
      }) as typeof read;
    }
    return opened;
  };
  const create = () => createClaudeCodeSessionsConnector({ path: root }, { openFile });
  const h = host();
  expect(texts(await h.pass(create()))).toEqual(["first"]);
  readBytes = 0;
  const appended = JSON.stringify(claudeTurn("new", "new")) + "\n";
  await appendFile(file, appended);
  const events = await h.pass(create());
  expect(readBytes).toBeLessThanOrEqual(Buffer.byteLength(appended) + 300 * 1024);
  expect(texts(events)).toEqual(["new"]);
});

test("rewrite, truncation and replacement reread safely without losing new evidence", async () => {
  const root = await tempRoot();
  const file = await writeJsonl(root, "a.jsonl", [claudeTurn("one", "one"), claudeTurn("two", "two")]);
  const h = host();
  const create = () => createClaudeCodeSessionsConnector({ path: root });
  const ledger = new InMemoryLedger();
  ledger.acceptMany(await h.pass(create()));
  await writeFile(file, [claudeTurn("one", "one"), claudeTurn("three", "three")].map((r) => JSON.stringify(r)).join("\n") + "\n");
  expect(ledger.acceptMany(await h.pass(create())).filter((r) => r.status === "stored")).toHaveLength(1);
  await truncate(file, 0);
  expect(await h.pass(create())).toEqual([]);
  await appendFile(file, JSON.stringify(claudeTurn("four", "four")) + "\n");
  expect(texts(await h.pass(create()))).toEqual(["four"]);
  const replacement = await writeJsonl(root, "replacement.tmp", [claudeTurn("five", "five")]);
  await rename(replacement, file);
  expect(texts(await h.pass(create()))).toEqual(["five"]);
});

test("10,000 transcript files stay within both host checkpoint bounds", async () => {
  const root = await tempRoot();
  // Sequential writes keep the test's own I/O bounded on the shared machine.
  for (let i = 0; i < 10_000; i++) await writeJsonl(root, `s-${i}.jsonl`, [claudeTurn(`u-${i}`, "turn")]);
  const h = host();
  const events = await h.pass(createClaudeCodeSessionsConnector({ path: root }));
  expect(events).toHaveLength(10_000);
  expect(h.store.size).toBeGreaterThan(0);
}, 120_000);

test("25 active sessions growing by ten lines emit zero duplicate events", async () => {
  const root = await tempRoot();
  const files = [];
  for (let i = 0; i < 25; i++) files.push(await writeJsonl(root, `s-${i}.jsonl`, Array.from({ length: 100 }, (_, j) => claudeTurn(`u-${i}-${j}`, `turn ${j}`))));
  const h = host();
  const connector = createClaudeCodeSessionsConnector({ path: root });
  const ledger = new InMemoryLedger();
  ledger.acceptMany(await h.pass(connector));
  for (let i = 0; i < files.length; i++) await appendFile(files[i]!, Array.from({ length: 10 }, (_, j) => JSON.stringify(claudeTurn(`new-${i}-${j}`, `new turn ${j}`))).join("\n") + "\n");
  const cpu = process.cpuUsage();
  const started = performance.now();
  const events = await h.pass(connector);
  const used = process.cpuUsage(cpu);
  console.info(`synthetic session pass: events=${events.length} cpu_ms=${(used.user + used.system) / 1000} wall_ms=${performance.now() - started}`);
  expect(ledger.acceptMany(events).filter((r) => r.status === "duplicate")).toHaveLength(0);
  expect(events).toHaveLength(250);
});

for (const entrypoint of ["print", "sdk", "sdk-cli", "sdk-ts", "sdk-py"]) {
  test(`Claude Code ${entrypoint} metadata is skipped only when include_headless is false`, async () => {
    const root = await tempRoot();
    await writeJsonl(root, "a.jsonl", [claudeTurn("headless", "automated", { entrypoint }), claudeTurn("owner", "interactive")]);
    expect(texts(await host().pass(createClaudeCodeSessionsConnector({ path: root })))).toEqual(["automated", "interactive"]);
    expect(texts(await host().pass(createClaudeCodeSessionsConnector({ path: root, include_headless: false })))).toEqual(["interactive"]);
  });
}
for (const metadata of [{ source: "exec" }, { originator: "codex_exec" }]) {
  test(`Codex headless metadata ${JSON.stringify(metadata)} is skipped`, async () => {
    const root = await tempRoot();
    await writeJsonl(root, "a.jsonl", [codexMeta(metadata), codexTurn("user", "automated")]);
    expect(texts(await host().pass(createCodexSessionsConnector({ path: root })))).toEqual(["automated"]);
    expect(await host().pass(createCodexSessionsConnector({ path: root, include_headless: false }))).toEqual([]);
  });
}

test("Codex append after restart retains session metadata and original line identities", async () => {
  const root = await tempRoot();
  const file = await writeJsonl(root, "a.jsonl", [codexMeta({ source: "cli" }), codexTurn("user", "first")]);
  const h = host();
  await h.pass(createCodexSessionsConnector({ path: root }));
  await appendFile(file, JSON.stringify(codexTurn("assistant", "second")) + "\n");
  const events = await h.pass(createCodexSessionsConnector({ path: root }));
  expect(texts(events)).toEqual(["second"]);
  expect(events[0]?.source_record_id).toBe("codex-session-1/L3");
  expect(events[0]?.metadata["cwd_basename"]).toBe("example-service");
});

test("complete-line offsets leave a partial UTF-8 line for the next pass", async () => {
  const root = await tempRoot();
  const file = await writeJsonl(root, "a.jsonl", [claudeTurn("first", "first")]);
  const h = host();
  const create = () => createClaudeCodeSessionsConnector({ path: root });
  await h.pass(create());
  const line = Buffer.from(JSON.stringify(claudeTurn("later", "later 雪")) + "\n");
  const split = line.indexOf(Buffer.from("雪")) + 1;
  await appendFile(file, line.subarray(0, split));
  expect(await h.pass(create())).toEqual([]);
  await appendFile(file, line.subarray(split));
  expect(texts(await h.pass(create()))).toEqual(["later 雪"]);
});

test("a rewritten mid-page transcript restarts instead of skipping unseen replacement lines", async () => {
  const root = await tempRoot();
  const file = await writeJsonl(root, "a.jsonl", Array.from({ length: 510 }, (_, i) => claudeTurn(`u-${i}`, `old ${i}`)));
  const first = await createClaudeCodeSessionsConnector({ path: root }).sync(null, { cursor_store: new Map() });
  expect(first.has_more).toBe(true);
  const store = new Map(Object.entries(first.cursor_store ?? {}).filter((entry): entry is [string, string] => entry[1] !== null));
  await writeFile(file, JSON.stringify(claudeTurn("replacement", "replacement")) + "\n");
  const next = await createClaudeCodeSessionsConnector({ path: root }).sync(first.cursor, { cursor_store: store });
  expect(texts(next.events)).toEqual(["replacement"]);
});

test("an uncommitted batch does not move offsets; retry replays the same evidence", async () => {
  const root = await tempRoot();
  await writeJsonl(root, "a.jsonl", [claudeTurn("one", "one")]);
  const store = new Map<string, string>();
  const connector = createClaudeCodeSessionsConnector({ path: root }, { now: () => Date.parse("2026-01-20T00:00:00Z") });
  const first = await connector.sync(null, { cursor_store: store });
  const retry = await connector.sync(null, { cursor_store: store });
  expect(retry).toEqual(first);
  expect(store.size).toBe(0);
});

test("Claude Code SDK metadata on an attachment applies to subsequent turns", async () => {
  const root = await tempRoot();
  await writeJsonl(root, "a.jsonl", [{ type: "attachment", entrypoint: "sdk-cli" }, claudeTurn("automated", "automated", { entrypoint: undefined })]);
  expect(await host().pass(createClaudeCodeSessionsConnector({ path: root, include_headless: false }))).toEqual([]);
});

test("SDK classification from a later metadata line survives an incremental restart", async () => {
  const root = await tempRoot();
  const file = await writeJsonl(root, "a.jsonl", [{ type: "progress" }, { type: "attachment", entrypoint: "sdk-cli" }, claudeTurn("automated", "automated", { entrypoint: undefined })]);
  const h = host();
  const create = () => createClaudeCodeSessionsConnector({ path: root, include_headless: false });
  expect(await h.pass(create())).toEqual([]);
  await appendFile(file, JSON.stringify(claudeTurn("later", "later", { entrypoint: undefined })) + "\n");
  expect(await h.pass(create())).toEqual([]);
});

test("malformed host offsets fail closed without moving the committed state", async () => {
  const root = await tempRoot();
  await writeJsonl(root, "a.jsonl", [claudeTurn("one", "one")]);
  const connector = createClaudeCodeSessionsConnector({ path: root });
  const first = await connector.sync(null, { cursor_store: new Map() });
  const store = new Map(Object.entries(first.cursor_store ?? {}).filter((entry): entry is [string, string] => entry[1] !== null));
  expect(store.size).toBe(1);
  const key = store.keys().next().value!;
  for (const value of ["[]", "not-json", "{}", JSON.stringify(["x"])] ) {
    await expect(connector.sync(first.cursor, { cursor_store: new Map([[key, value]]) })).rejects.toMatchObject({ code: "corrupted" });
  }
  expect((await connector.sync(first.cursor, { cursor_store: store })).events).toEqual([]);
});
