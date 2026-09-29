import { expect, test } from "bun:test";
import { appendFile, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { MAX_CURSOR_BYTES } from "@kizuki/core";
import { InMemoryLedger } from "../../connectors/src/testkit";
import { MAX_BATCH_EVENTS, MAX_SCAN_BYTES, OVERLAP_MS, parseCursor } from "../src";
import { encodeCursor } from "../src/cursor";
import type { SessionsCursor } from "../src";
import { claudeTurn, connectorFor, drain, tempRoot, texts, writeJsonl } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const filesRead = async (connector: ReturnType<typeof connectorFor>): Promise<number> =>
  Number(/(?:^| )files=(\d+)/.exec((await connector.health()).detail ?? "")?.[1] ?? 0);

test("the cursor stays inside its bound for the longest position it can hold", () => {
  const cursor: SessionsCursor = {
    schema: "kizuki.agent-sessions-cursor/v1",
    root_sha256: "a".repeat(64),
    watermark_ms: Number.MAX_SAFE_INTEGER,
    after: { mtime_ms: Number.MAX_SAFE_INTEGER, relpath: "\u0001".repeat(1024), line: Number.MAX_SAFE_INTEGER },
    exhausted: false,
  };
  const encoded = encodeCursor(cursor);

  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_CURSOR_BYTES);
  expect(parseCursor(encoded)).toEqual(cursor);
});

test("a cursor this connector did not mint is refused with a typed error", async () => {
  const root = await tempRoot();
  await writeJsonl(root, "proj/a.jsonl", [claudeTurn("u-1", "one")]);
  const connector = connectorFor("claude-code", { path: root });
  const good = (await connector.sync(null)).cursor!;
  const parsed = JSON.parse(good) as Record<string, unknown>;

  for (const bad of [
    "\u0000not-a-cursor",
    "[]",
    JSON.stringify({ ...parsed, extra: 1 }),
    JSON.stringify({ ...parsed, watermark_ms: -1 }),
    JSON.stringify({ ...parsed, root_sha256: "xyz" }),
    JSON.stringify({ ...parsed, after: { mtime_ms: 1, relpath: "", line: 1 }, exhausted: false }),
    JSON.stringify({ ...parsed, after: { mtime_ms: 1, relpath: "a.jsonl", line: 1 } }),
    "x".repeat(MAX_CURSOR_BYTES + 1),
  ]) {
    await expect(connector.sync(bad)).rejects.toMatchObject({ code: "corrupted" });
  }
  const other = await tempRoot();
  await expect(connectorFor("claude-code", { path: other }).sync(good)).rejects.toMatchObject({ code: "misconfigured" });
});

test("a pass stops at the batch bound and resumes mid-file from a persisted cursor", async () => {
  const root = await tempRoot();
  const total = MAX_BATCH_EVENTS * 2 + 100;
  await writeJsonl(root, "proj/long.jsonl", Array.from({ length: total }, (_, i) => claudeTurn(`u-${i}`, `turn ${i}`)));

  const first = await connectorFor("claude-code", { path: root }).sync(null);
  expect(first.events).toHaveLength(MAX_BATCH_EVENTS);
  expect(first.has_more).toBe(true);
  expect(parseCursor(first.cursor!).after).toMatchObject({ relpath: "proj/long.jsonl", line: MAX_BATCH_EVENTS });

  // A fresh instance stands in for a restart: only the cursor string survives.
  const rest = await drain(connectorFor("claude-code", { path: root }), first.cursor);
  const ids = [...first.events, ...rest.events].map((event) => event.source_record_id);
  expect(ids).toHaveLength(total);
  expect(new Set(ids).size).toBe(total);
  expect(ids[MAX_BATCH_EVENTS]).toBe("session-1/u-500");
  expect(parseCursor(rest.cursor!)).toMatchObject({ after: null, exhausted: true });
});

test("a call stops once it has decoded its scan budget, however few events that produced", async () => {
  const root = await tempRoot();
  const megabyte = "y".repeat(1024 * 1024 - 300);
  const lines = MAX_SCAN_BYTES / (1024 * 1024) + 2;
  await writeJsonl(root, "proj/heavy.jsonl", Array.from({ length: lines }, (_, i) => claudeTurn(`u-${i}`, megabyte)));

  const first = await connectorFor("claude-code", { path: root }).sync(null);
  expect(first.has_more).toBe(true);
  expect(first.events.length).toBeLessThan(lines);
  expect(first.events.length).toBeLessThanOrEqual(MAX_SCAN_BYTES / (1024 * 1024 - 300) + 1);
  const rest = await drain(connectorFor("claude-code", { path: root }), first.cursor);
  expect(first.events.length + rest.events.length).toBe(lines);
}, 30_000);

test("a resumed file that kept growing continues at its line instead of starting over", async () => {
  const root = await tempRoot();
  const file = await writeJsonl(root, "proj/live.jsonl", Array.from({ length: MAX_BATCH_EVENTS + 5 }, (_, i) => claudeTurn(`u-${i}`, `turn ${i}`)));
  const first = await connectorFor("claude-code", { path: root }).sync(null);
  await appendFile(file, JSON.stringify(claudeTurn("u-late", "appended between calls")) + "\n");

  const rest = await drain(connectorFor("claude-code", { path: root }), first.cursor);
  expect(rest.events.map((event) => event.source_record_id)).toEqual([
    ...Array.from({ length: 5 }, (_, i) => `session-1/u-${MAX_BATCH_EVENTS + i}`),
    "session-1/u-late",
  ]);
});

test("an unterminated final line is left for the pass after it is finished", async () => {
  const root = await tempRoot();
  const file = await writeJsonl(root, "proj/a.jsonl", [claudeTurn("u-1", "done")]);
  const half = JSON.stringify(claudeTurn("u-2", "half written"));
  await appendFile(file, half.slice(0, 20));
  const connector = connectorFor("claude-code", { path: root });

  const first = await drain(connector);
  expect(texts(first.events)).toEqual(["done"]);
  await appendFile(file, half.slice(20) + "\n");
  expect(texts((await drain(connector, first.cursor)).events)).toEqual(["done", "half written"]);
});

test("a pass over a generated tree reads only the files touched since the watermark", async () => {
  const root = await tempRoot();
  const start = Date.now() - 400 * DAY;
  const paths: string[] = [];
  for (let project = 0; project < 20; project += 1) {
    for (let session = 0; session < 10; session += 1) {
      const index = project * 10 + session;
      paths.push(
        await writeJsonl(
          root,
          `project-${project}/session-${session}.jsonl`,
          [1, 2].map((n) => claudeTurn(`u-${index}-${n}`, `turn ${index}.${n}`, { sessionId: `s-${index}` })),
          new Date(start + index * DAY),
        ),
      );
    }
  }
  const connector = connectorFor("claude-code", { path: root });

  const initial = await drain(connector);
  expect(initial.events).toHaveLength(400);
  expect(await filesRead(connector)).toBe(200);

  // Nothing changed: only the newest file, which sits inside the overlap, is read again.
  const quiet = await drain(connector, initial.cursor);
  expect(new Set(quiet.events.map((event) => event.metadata["session_id"]))).toEqual(new Set(["s-199"]));
  expect(await filesRead(connector)).toBe(201);

  const touched = [3, 77, 150, 151, 198];
  for (const index of touched) {
    await appendFile(paths[index]!, JSON.stringify(claudeTurn(`u-${index}-new`, `new ${index}`, { sessionId: `s-${index}` })) + "\n");
    await utimes(paths[index]!, new Date(), new Date());
  }
  const before = await filesRead(connector);
  const next = await drain(connector, quiet.cursor);

  // Five touched files plus the previous newest, re-read for the overlap.
  expect(await filesRead(connector)).toBe(before + 6);
  const sources = new Set(next.events.map((event) => event.metadata["session_id"]));
  expect(sources.size).toBe(6);
  expect(texts(next.events).filter((text) => text.startsWith("new "))).toHaveLength(5);

  // Whatever is re-read deduplicates in the ledger: nothing changed but the five appended turns.
  const ledger = new InMemoryLedger();
  ledger.acceptMany(initial.events);
  const accepted = ledger.acceptMany(next.events);
  expect(accepted.filter((accept) => accept.status === "stored")).toHaveLength(5);
}, 30_000);

test("the overlap re-reads a file written just before the watermark", async () => {
  const root = await tempRoot();
  const now = Date.now();
  const file = await writeJsonl(root, "proj/a.jsonl", [claudeTurn("u-1", "one")], new Date(now - 60_000));
  await writeJsonl(root, "proj/b.jsonl", [claudeTurn("u-2", "two")], new Date(now - 10_000));
  const connector = connectorFor("claude-code", { path: root });
  const first = await drain(connector);

  await appendFile(file, JSON.stringify(claudeTurn("u-3", "late append")) + "\n");
  await utimes(file, new Date(now - 30_000), new Date(now - 30_000));
  const second = await drain(connector, first.cursor);

  expect(texts(second.events)).toContain("late append");
  expect(OVERLAP_MS).toBeGreaterThan(30_000);
});

test("a file dated in the future cannot park the watermark past real writes", async () => {
  const root = await tempRoot();
  await writeJsonl(root, "proj/future.jsonl", [claudeTurn("u-1", "from the future")], new Date("2999-01-01T00:00:00Z"));
  const connector = connectorFor("claude-code", { path: root });
  const first = await drain(connector);

  expect(parseCursor(first.cursor!).watermark_ms).toBeLessThanOrEqual(Date.now());
  await writeJsonl(root, "proj/now.jsonl", [claudeTurn("u-2", "written now")]);
  expect(texts((await drain(connector, first.cursor)).events)).toContain("written now");
});

test("a rewritten or truncated file is read again from its start and never becomes a tombstone", async () => {
  const root = await tempRoot();
  const file = await writeJsonl(root, "proj/a.jsonl", [claudeTurn("u-1", "one"), claudeTurn("u-2", "two"), claudeTurn("u-3", "three")], new Date(Date.now() - DAY));
  const connector = connectorFor("claude-code", { path: root });
  const first = await drain(connector);
  expect(first.events).toHaveLength(3);

  await writeFile(file, JSON.stringify(claudeTurn("u-9", "replacement")) + "\n" + JSON.stringify(claudeTurn("u-1", "one")) + "\n");
  const rewritten = await drain(connector, first.cursor);
  expect(texts(rewritten.events)).toEqual(["replacement", "one"]);

  await truncate(file, 0);
  await utimes(file, new Date(), new Date());
  const emptied = await drain(connector, rewritten.cursor);
  expect(emptied.events).toEqual([]);
  expect(rewritten.events.concat(emptied.events).some((event) => event.deleted)).toBe(false);
});

test("a vanished file emits no tombstone and no error", async () => {
  const root = await tempRoot();
  const file = await writeJsonl(root, "proj/a.jsonl", [claudeTurn("u-1", "one")], new Date(Date.now() - DAY));
  await writeJsonl(root, "proj/b.jsonl", [claudeTurn("u-2", "two")], new Date(Date.now() - 2 * DAY));
  const connector = connectorFor("claude-code", { path: root });
  const first = await drain(connector);

  await rm(file);
  const after = await drain(connector, first.cursor);
  expect(after.events).toEqual([]);
});

test("a source directory that vanishes is unavailable, never an empty page", async () => {
  const root = await tempRoot();
  await writeJsonl(root, "proj/a.jsonl", [claudeTurn("u-1", "one")]);
  const connector = connectorFor("claude-code", { path: root });
  const first = await drain(connector);

  await rm(root, { recursive: true });
  await expect(connector.sync(first.cursor)).rejects.toMatchObject({ code: "unavailable" });
});

test("backfill and sync are one walk: a finished backfill cursor lets sync continue from its watermark", async () => {
  const root = await tempRoot();
  await writeJsonl(root, "proj/a.jsonl", [claudeTurn("u-1", "one")], new Date(Date.now() - DAY));
  const connector = connectorFor("claude-code", { path: root });
  const backfill = await connector.backfill(null);
  expect(backfill.has_more).toBe(false);

  await writeJsonl(root, "proj/b.jsonl", [claudeTurn("u-2", "two")]);
  // The newest backfilled file is read again for the overlap; the ledger deduplicates it.
  expect(texts((await connector.sync(backfill.cursor)).events)).toEqual(["one", "two"]);
});
