import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_CURSOR_BYTES,
  MAX_SYNC_BATCH_BYTES,
  MAX_SYNC_BATCH_EVENTS,
  getCheckpoint,
  listConnectionRuns,
  registerConnection,
  replay,
  runBackfill,
  runToCompletion,
  setSourceGrant,
} from "@kizuki/core";
import type { CaptureEvent, Cursor, SyncBatch } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import {
  CHATGPT_IMPORT_CONNECTOR_ID,
  KizukiError,
  createChatGptImportConnector,
} from "../src";
import { IMPORT_SNAPSHOT_CURSOR_SCHEMA } from "../src/import-snapshot";
import { sha256Hex } from "../src/source-id";

const SOURCE_KEY = "01JJ0000000000000000000019";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function syntheticDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-snapshot-core-"));
  roots.push(root);
  return root;
}

function conversations(count: number, text: (index: number) => string): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `conversation-${index}`,
    mapping: {
      n: {
        message: {
          author: { role: "user" },
          content: { parts: [text(index)] },
          create_time: 1_700_000_000 + index,
        },
      },
    },
  }));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function grant(db: ReturnType<typeof openLedger>): void {
  setSourceGrant(db, {
    source_key: SOURCE_KEY,
    expected_revision: 0,
    operation_id: "synthetic-snapshot-grant",
    policy: {
      purposes: ["capture", "recall", "derive"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "public",
    },
  });
}

function vault(): ReturnType<typeof openLedger> {
  const db = openLedger(":memory:");
  registerConnection(db, CHATGPT_IMPORT_CONNECTOR_ID, SOURCE_KEY);
  grant(db);
  return db;
}

function stored(db: ReturnType<typeof openLedger>): CaptureEvent[] {
  return [...replay(db, {})];
}

function snapshotCursor(cursor: Cursor | null): {
  schema: string;
  connector_id: string;
  exhausted: boolean;
  offset: number;
  export: { sha256: string; size: number };
} {
  if (cursor === null) throw new Error("expected a snapshot cursor");
  return JSON.parse(cursor) as {
    schema: string;
    connector_id: string;
    exhausted: boolean;
    offset: number;
    export: { sha256: string; size: number };
  };
}

function assertHostBounds(batch: SyncBatch): void {
  expect(batch.events.length).toBeLessThanOrEqual(MAX_SYNC_BATCH_EVENTS);
  expect(utf8Bytes(JSON.stringify(batch.events))).toBeLessThanOrEqual(
    MAX_SYNC_BATCH_BYTES,
  );
  if (batch.cursor !== null) {
    expect(utf8Bytes(batch.cursor)).toBeLessThanOrEqual(MAX_CURSOR_BYTES);
  }
}

async function writeConversations(
  file: string,
  count: number,
  text: (index: number) => string,
): Promise<string> {
  const body = JSON.stringify(conversations(count, text));
  await writeFile(file, body);
  return body;
}

function legacyV1Cursor(connectorId: string, text: string): string {
  return JSON.stringify({
    schema: IMPORT_SNAPSHOT_CURSOR_SCHEMA,
    connector_id: connectorId,
    exhausted: true,
    export: { sha256: sha256Hex(text), size: utf8Bytes(text) },
    records: [["conversation-0/n", "legacy-hash"]],
  });
}

test("Core runToCompletion captures 200 records with a bounded resume cursor", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "conversations.json");
  await writeConversations(file, 200, (index) => `msg-${index}`);
  const connector = createChatGptImportConnector({ path: file });
  const firstPage = await connector.backfill(null);
  assertHostBounds(firstPage);
  expect(utf8Bytes(firstPage.cursor ?? "")).toBeLessThanOrEqual(MAX_CURSOR_BYTES);
  expect(snapshotCursor(firstPage.cursor).schema).toBe(
    IMPORT_SNAPSHOT_CURSOR_SCHEMA,
  );

  const db = vault();
  try {
    const result = await runToCompletion(
      db,
      connector,
      CHATGPT_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
    );
    expect(result.errors).toEqual([]);
    expect(result.stored).toBe(200);
    expect(result.duplicates).toBe(0);
    expect(utf8Bytes(result.cursor ?? "")).toBeLessThanOrEqual(MAX_CURSOR_BYTES);
    expect(snapshotCursor(result.cursor).exhausted).toBe(true);
    expect(stored(db)).toHaveLength(200);
    expect(stored(db).some((event) => event.deleted)).toBe(false);
  } finally {
    db.close();
  }
}, 30_000);

test("Core runToCompletion pages a capture larger than 4MiB", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "conversations.json");
  const payload = "x".repeat(850_000);
  await writeConversations(file, 5, () => payload);
  const connector = createChatGptImportConnector({ path: file });
  const first = await connector.backfill(null);
  assertHostBounds(first);
  expect(first.events.length).toBeGreaterThan(0);
  expect(first.events.length).toBeLessThan(5);
  expect(first.has_more).toBe(true);
  expect(utf8Bytes(JSON.stringify(first.events))).toBeGreaterThan(0);

  const db = vault();
  try {
    const result = await runToCompletion(
      db,
      connector,
      CHATGPT_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
    );
    expect(result.errors).toEqual([]);
    expect(result.stored).toBe(5);
    expect(snapshotCursor(result.cursor).exhausted).toBe(true);
    expect(stored(db)).toHaveLength(5);
  } finally {
    db.close();
  }
}, 30_000);

test("Core can interrupt and restart a paged snapshot without loss", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "conversations.json");
  const count = MAX_SYNC_BATCH_EVENTS + 1;
  const body = await writeConversations(file, count, (index) => `item-${index}`);
  const connector = createChatGptImportConnector({ path: file });
  const db = vault();
  try {
    const first = await runToCompletion(
      db,
      connector,
      CHATGPT_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
      { maxBatches: 1 },
    );
    expect(first.stored).toBe(MAX_SYNC_BATCH_EVENTS);
    expect(first.errors).toEqual(["run did not complete within 1 batches"]);
    const checkpoint = getCheckpoint(db, CHATGPT_IMPORT_CONNECTOR_ID, SOURCE_KEY);
    expect(checkpoint?.cursor).not.toBeNull();
    expect(snapshotCursor(checkpoint?.cursor ?? null).offset).toBe(
      MAX_SYNC_BATCH_EVENTS,
    );

    await writeFile(file, "{");
    const failed = await runBackfill(
      db,
      connector,
      CHATGPT_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
    );
    expect(failed.stored).toBe(0);
    expect(failed.errors.join(" ")).toContain("malformed JSON");
    expect(getCheckpoint(db, CHATGPT_IMPORT_CONNECTOR_ID, SOURCE_KEY)?.cursor).toBe(
      checkpoint?.cursor,
    );

    await writeFile(file, body);
    const rest = await runToCompletion(
      db,
      connector,
      CHATGPT_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
    );
    expect(rest.errors).toEqual([]);
    expect(rest.stored).toBe(1);
    expect(stored(db)).toHaveLength(count);
    expect(stored(db).some((event) => event.deleted)).toBe(false);
  } finally {
    db.close();
  }
}, 60_000);

test("a changed export mid-drain rescans and keeps prior captures", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "conversations.json");
  const count = MAX_SYNC_BATCH_EVENTS + 1;
  await writeConversations(file, count, (index) => `old-${index}`);
  const connector = createChatGptImportConnector({ path: file });
  const db = vault();
  try {
    const first = await runToCompletion(
      db,
      connector,
      CHATGPT_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
      { maxBatches: 1 },
    );
    expect(first.stored).toBe(MAX_SYNC_BATCH_EVENTS);
    await writeConversations(file, count, (index) => `new-${index}`);
    const resumed = await runToCompletion(
      db,
      connector,
      CHATGPT_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
    );
    expect(resumed.errors).toEqual([]);
    expect(resumed.stored).toBe(count);
    expect(resumed.duplicates).toBe(0);
    expect(stored(db).some((event) => event.deleted)).toBe(false);
    expect(stored(db).length).toBe(MAX_SYNC_BATCH_EVENTS + count);
    const texts = new Set(stored(db).map((event) => event.text));
    expect(texts.has("old-0")).toBe(true);
    expect(texts.has("new-0")).toBe(true);
    expect(texts.has(`new-${count - 1}`)).toBe(true);
  } finally {
    db.close();
  }
}, 60_000);

test("an exhausted snapshot does not repeat empty success", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "conversations.json");
  await writeConversations(file, 3, (index) => `idle-${index}`);
  const connector = createChatGptImportConnector({ path: file });
  const db = vault();
  try {
    const first = await runToCompletion(
      db,
      connector,
      CHATGPT_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
    );
    expect(first).toMatchObject({ stored: 3, duplicates: 0, errors: [] });
    expect(listConnectionRuns(db, CHATGPT_IMPORT_CONNECTOR_ID, SOURCE_KEY)).toHaveLength(
      1,
    );
    const idle = await runToCompletion(
      db,
      connector,
      CHATGPT_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
    );
    expect(idle).toMatchObject({ stored: 0, duplicates: 0, errors: [] });
    expect(idle.cursor).toBe(first.cursor);
    const again = await runToCompletion(
      db,
      connector,
      CHATGPT_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
    );
    expect(again).toMatchObject({ stored: 0, duplicates: 0, errors: [] });
    expect(again.cursor).toBe(first.cursor);
    const runs = listConnectionRuns(db, CHATGPT_IMPORT_CONNECTOR_ID, SOURCE_KEY);
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.status === "ok")).toBe(true);
    expect(stored(db)).toHaveLength(3);
  } finally {
    db.close();
  }
});

test("a legacy v1 exhausted cursor idles unchanged and rescans a new export", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "conversations.json");
  const text = await writeConversations(file, 2, (index) => `legacy-${index}`);
  const connector = createChatGptImportConnector({ path: file });
  const legacy = legacyV1Cursor(CHATGPT_IMPORT_CONNECTOR_ID, text);
  expect(utf8Bytes(legacy)).toBeLessThanOrEqual(MAX_CURSOR_BYTES);

  const idle = await connector.backfill(legacy);
  expect(idle).toEqual({ events: [], cursor: legacy, has_more: false });

  await writeConversations(file, 2, (index) => `replaced-${index}`);
  const rescanned = await connector.sync(legacy);
  expect(rescanned.events.some((event) => event.deleted)).toBe(false);
  expect(rescanned.events).toHaveLength(2);
  expect(rescanned.events.map((event) => event.text)).toEqual([
    "replaced-0",
    "replaced-1",
  ]);
  const next = snapshotCursor(rescanned.cursor);
  expect(next.schema).toBe(IMPORT_SNAPSHOT_CURSOR_SCHEMA);
  expect(next.exhausted).toBe(true);
  expect(next.offset).toBe(2);
  expect("records" in (JSON.parse(rescanned.cursor ?? "{}") as object)).toBe(
    false,
  );
});

test("snapshot pages stay inside host cursor, count, and byte bounds", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "conversations.json");
  const count = MAX_SYNC_BATCH_EVENTS + 1;
  await writeConversations(file, count, (index) => `bound-${index}`);
  const connector = createChatGptImportConnector({ path: file });
  const pages: SyncBatch[] = [];
  let cursor: Cursor | null = null;
  for (let step = 0; step < 8; step += 1) {
    const batch = await connector.backfill(cursor);
    pages.push(batch);
    assertHostBounds(batch);
    if (batch.has_more !== true) break;
    cursor = batch.cursor;
  }
  expect(pages).toHaveLength(2);
  expect(pages[0]?.events).toHaveLength(MAX_SYNC_BATCH_EVENTS);
  expect(pages[0]?.has_more).toBe(true);
  expect(pages[1]?.events).toHaveLength(1);
  expect(pages[1]?.has_more).toBe(false);
  expect(snapshotCursor(pages[1]?.cursor ?? null).exhausted).toBe(true);
}, 30_000);

test("dirty records never complete and remain retryable after repair", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "conversations.json");
  const valid = conversations(3, (index) => `keep-${index}`);
  await writeFile(file, JSON.stringify([...valid, "not-an-object"]));
  const connector = createChatGptImportConnector({ path: file });
  const db = vault();
  try {
    const dirty = await runToCompletion(
      db,
      connector,
      CHATGPT_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
    );
    expect(dirty.stored).toBe(3);
    expect(dirty.errors.join(" ")).toContain("partial_import");
    expect(snapshotCursor(dirty.cursor).exhausted).toBe(false);
    expect(stored(db)).toHaveLength(3);

    await writeConversations(file, 4, (index) =>
      index < 3 ? `keep-${index}` : "repaired",
    );
    const repaired = await runToCompletion(
      db,
      connector,
      CHATGPT_IMPORT_CONNECTOR_ID,
      SOURCE_KEY,
      "backfill",
    );
    expect(repaired.errors).toEqual([]);
    expect(repaired.stored).toBe(1);
    expect(repaired.duplicates).toBe(3);
    expect(snapshotCursor(repaired.cursor).exhausted).toBe(true);
    expect(stored(db).map((event) => event.text).sort()).toEqual([
      "keep-0",
      "keep-1",
      "keep-2",
      "repaired",
    ]);
  } finally {
    db.close();
  }
}, 30_000);

test("a corrupt snapshot cursor is refused", async () => {
  const root = await syntheticDir();
  const file = path.join(root, "conversations.json");
  await writeConversations(file, 1, () => "ok");
  const connector = createChatGptImportConnector({ path: file });
  try {
    await connector.backfill("\u0000not-a-cursor");
    throw new Error("expected parse_error");
  } catch (error) {
    expect(error).toBeInstanceOf(KizukiError);
    if (!(error instanceof KizukiError)) return;
    expect(error.code).toBe("parse_error");
    expect(error.message).toContain("malformed snapshot cursor");
  }
});
