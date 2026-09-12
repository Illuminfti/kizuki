import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnectionStateStore,
  getCheckpoint,
  getConnection,
  replayLive,
  runToCompletion,
  setSourceGrant,
} from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { IMAP_CONNECTOR_ID, createImapConnector } from "../src/connector";
import { BATCH } from "../src/mailbox";
import { DEFAULT_MAX_MESSAGE_BYTES, serializeImapState } from "../src/state";
import type { ImapState } from "../src/state";
import { FakeImapServer } from "../src/testing/fake-imap";
import type { FakeFolder } from "../src/testing/fake-imap";
import { fixtureMailbox, fixtureState, memoryDialer } from "../src/testing";

const directories: string[] = [];
const NOW = (): Date => new Date("2026-03-02T00:00:00.000Z");
const encoder = new TextEncoder();

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-imap-native-"));
  directories.push(directory);
  return directory;
}

function message(
  uid: number,
  subject: string,
): { uid: number; internaldate: string; raw: Uint8Array } {
  return {
    uid,
    internaldate: "01-Mar-2026 08:00:00 +0000",
    raw: encoder.encode(
      [
        "From: Ada <ada@acme.example>",
        "To: grace@acme.example",
        `Subject: ${subject}`,
        "Date: Sun, 01 Mar 2026 08:00:00 +0000",
        `Message-ID: <${uid}@acme.example>`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        `Body of ${subject}`,
        "",
      ].join("\r\n"),
    ),
  };
}

function inbox(count: number, uidvalidity = 5): FakeFolder {
  return {
    wire: "INBOX",
    attributes: ["\\HasNoChildren"],
    uidvalidity,
    uidnext: count + 1,
    messages: Array.from({ length: count }, (_unused, index) =>
      message(index + 1, `note ${index + 1}`),
    ),
  };
}

function stateFor(folders: string[]): ImapState {
  return {
    schema: "kizuki.imap-state/v1",
    host: "mail.acme.example",
    port: 993,
    username: "ada@acme.example",
    password: "app-password",
    folders,
    max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
  };
}

function grant(db: ReturnType<typeof openLedger>, source: string): void {
  setSourceGrant(db, {
    source_key: source,
    expected_revision: 0,
    operation_id: "synthetic-imap-grant",
    policy: {
      purposes: ["capture"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "private",
    },
  });
}

async function enrolled(
  root: string,
  db: ReturnType<typeof openLedger>,
  server: FakeImapServer,
  imapState: ImapState,
): Promise<{
  connector: ReturnType<typeof createImapConnector>;
  source: string;
}> {
  const store = new ConnectionStateStore(root);
  const enrollment = store.begin();
  await enrollment.writer.write(serializeImapState(imapState));
  const connection = store.save(db, IMAP_CONNECTOR_ID, enrollment.pending);
  grant(db, connection.source_key);
  const connector = createImapConnector(
    { secret_ref: connection.secret_refs[0] ?? "" },
    { dial: memoryDialer(server), now: NOW },
  );
  await connector.connect(
    async () =>
      new TextDecoder().decode(store.read(connection) ?? new Uint8Array()),
  );
  return { connector, source: connection.source_key };
}

async function reopen(
  root: string,
  database: string,
  server: FakeImapServer,
  source: string,
): Promise<{
  db: ReturnType<typeof openLedger>;
  connector: ReturnType<typeof createImapConnector>;
}> {
  const db = openLedger(database);
  const store = new ConnectionStateStore(root);
  expect(store.recover(db).unresolved).toEqual([]);
  const connection = getConnection(db, IMAP_CONNECTOR_ID, source);
  expect(connection).not.toBeNull();
  if (connection === null) throw new Error("missing connection after reopen");
  const connector = createImapConnector(
    { secret_ref: connection.secret_refs[0] ?? "" },
    { dial: memoryDialer(server), now: NOW },
  );
  await connector.connect(
    async () =>
      new TextDecoder().decode(store.read(connection) ?? new Uint8Array()),
  );
  return { db, connector };
}

function liveIds(db: ReturnType<typeof openLedger>): string[] {
  return [...replayLive(db)].map((event) => event.source_record_id).sort();
}

function tombstoneIds(db: ReturnType<typeof openLedger>): string[] {
  return db
    .query<{ source_record_id: string }, []>(
      "SELECT source_record_id FROM events WHERE deleted = 1 ORDER BY source_record_id",
    )
    .all()
    .map((row) => row.source_record_id);
}

test("an interrupted sync page reopens from the durable checkpoint without duplicate ids", async () => {
  const root = temporary();
  const database = join(root, "ledger.db");
  let db = openLedger(database);
  // One full page plus one record is sufficient to exercise a durable
  // checkpoint/reopen boundary without making this native-ledger test exceed
  // Bun's default per-test deadline.
  const total = BATCH + 1;
  const server = new FakeImapServer([inbox(total)]);
  try {
    const { connector, source } = await enrolled(
      root,
      db,
      server,
      stateFor(["INBOX"]),
    );
    const first = await runToCompletion(
      db,
      connector,
      IMAP_CONNECTOR_ID,
      source,
      "sync",
      { maxBatches: 1 },
    );
    expect(first.stored).toBe(BATCH);
    expect(getCheckpoint(db, IMAP_CONNECTOR_ID, source)?.sync_cursor).not.toBeNull();
    db.close();

    const resumed = await reopen(root, database, server, source);
    db = resumed.db;
    const rest = await runToCompletion(
      db,
      resumed.connector,
      IMAP_CONNECTOR_ID,
      source,
      "sync",
    );
    expect(rest.errors).toEqual([]);
    expect(rest.stored).toBe(total - BATCH);
    const ids = liveIds(db);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    // `liveIds` sorts strings, so verify native UID membership rather than
    // incorrectly treating lexical ordering as numeric ordering.
    expect(ids).toContain("5:1:INBOX");
    expect(ids).toContain(`5:${total}:INBOX`);
    const replay = await runToCompletion(
      db,
      resumed.connector,
      IMAP_CONNECTOR_ID,
      source,
      "sync",
    );
    expect(replay.stored).toBe(0);
    expect(replay.errors).toEqual([]);
  } finally {
    db.close();
  }
});

test("a settled capture tombstones deletions and UIDVALIDITY resets after reopen", async () => {
  const root = temporary();
  const database = join(root, "ledger.db");
  let db = openLedger(database);
  const server = new FakeImapServer([inbox(4)]);
  try {
    const { connector, source } = await enrolled(
      root,
      db,
      server,
      stateFor(["INBOX"]),
    );
    expect(
      (
        await runToCompletion(db, connector, IMAP_CONNECTOR_ID, source, "sync")
      ).stored,
    ).toBe(4);
    db.close();

    server.expunge("INBOX", 2);
    server.append("INBOX", "Subject: fresh\r\n\r\nnew mail\r\n");
    const afterExpunge = await reopen(root, database, server, source);
    db = afterExpunge.db;
    const mixed = await runToCompletion(
      db,
      afterExpunge.connector,
      IMAP_CONNECTOR_ID,
      source,
      "sync",
    );
    expect(mixed.errors).toEqual([]);
    expect(tombstoneIds(db)).toEqual(["5:2:INBOX"]);
    expect(liveIds(db)).toEqual(["5:1:INBOX", "5:3:INBOX", "5:4:INBOX", "5:5:INBOX"]);
    db.close();

    server.resetUidValidity("INBOX");
    const afterReset = await reopen(root, database, server, source);
    db = afterReset.db;
    const reset = await runToCompletion(
      db,
      afterReset.connector,
      IMAP_CONNECTOR_ID,
      source,
      "sync",
    );
    expect(reset.errors).toEqual([]);
    expect(tombstoneIds(db)).toEqual([
      "5:1:INBOX",
      "5:2:INBOX",
      "5:3:INBOX",
      "5:4:INBOX",
      "5:5:INBOX",
    ]);
    expect(liveIds(db)).toEqual(["6:1:INBOX", "6:2:INBOX", "6:3:INBOX", "6:4:INBOX"]);
  } finally {
    db.close();
  }
});

test("a withheld body survives reopen on the pending checkpoint until the bytes arrive", async () => {
  const root = temporary();
  const database = join(root, "ledger.db");
  let db = openLedger(database);
  const server = new FakeImapServer([inbox(3)]);
  server.withholdBody("INBOX", 2);
  try {
    const { connector, source } = await enrolled(
      root,
      db,
      server,
      stateFor(["INBOX"]),
    );
    const first = await runToCompletion(
      db,
      connector,
      IMAP_CONNECTOR_ID,
      source,
      "backfill",
    );
    expect(first.stored).toBe(2);
    expect(getCheckpoint(db, IMAP_CONNECTOR_ID, source)?.backfill_complete).toBe(
      false,
    );
    db.close();

    server.restoreBody("INBOX", 2);
    const resumed = await reopen(root, database, server, source);
    db = resumed.db;
    const healed = await runToCompletion(
      db,
      resumed.connector,
      IMAP_CONNECTOR_ID,
      source,
      "backfill",
    );
    expect(healed.errors).toEqual([]);
    expect(healed.stored).toBe(1);
    expect(liveIds(db)).toEqual(["5:1:INBOX", "5:2:INBOX", "5:3:INBOX"]);
    expect(getCheckpoint(db, IMAP_CONNECTOR_ID, source)?.backfill_complete).toBe(
      true,
    );
  } finally {
    db.close();
  }
});

test("fixture MIME text and source provenance survive ledger reopen", async () => {
  const root = temporary();
  const database = join(root, "ledger.db");
  let db = openLedger(database);
  const server = new FakeImapServer(fixtureMailbox(), {
    username: fixtureState().username,
    password: fixtureState().password,
  });
  try {
    const { connector, source } = await enrolled(
      root,
      db,
      server,
      fixtureState(),
    );
    const captured = await runToCompletion(
      db,
      connector,
      IMAP_CONNECTOR_ID,
      source,
      "backfill",
    );
    expect(captured.errors).toEqual([]);
    expect(captured.stored).toBeGreaterThan(0);
    db.close();

    const resumed = await reopen(root, database, server, source);
    db = resumed.db;
    const rows = db
      .query<{
        source_record_id: string;
        connector_id: string;
        text: string;
        origin: string;
        origin_binding_kind: string;
        source_key: string;
      }, []>(
        `SELECT e.source_record_id, e.connector_id, e.text, e.origin, e.origin_binding_kind, b.source_key
           FROM events e JOIN source_event_bindings b ON b.event_id = e.event_id`,
      )
      .all();
    expect(rows.length).toBe(captured.stored);
    expect(rows.every((row) => row.connector_id === IMAP_CONNECTOR_ID)).toBe(true);
    expect(rows.every((row) => row.origin === "external")).toBe(true);
    expect(rows.every((row) => row.origin_binding_kind === "capture")).toBe(true);
    expect(rows.every((row) => row.source_key === source)).toBe(true);
    expect(rows.every((row) => /^\d+:\d+:INBOX$/.test(row.source_record_id))).toBe(
      true,
    );
    const eightBit = rows.find((row) => row.source_record_id === "42:14:INBOX");
    expect(eightBit?.text).toBe("Café order\n\nUne pièce de résistance.");
    const replay = await runToCompletion(
      db,
      resumed.connector,
      IMAP_CONNECTOR_ID,
      source,
      "backfill",
    );
    expect(replay.stored).toBe(0);
    expect(replay.errors).toEqual([]);
  } finally {
    db.close();
  }
});

test("a checkpoint insert failure after accept resumes without a second live row", async () => {
  const root = temporary();
  const database = join(root, "ledger.db");
  let db = openLedger(database);
  const server = new FakeImapServer([inbox(3)]);
  try {
    const { connector, source } = await enrolled(
      root,
      db,
      server,
      stateFor(["INBOX"]),
    );
    db.exec(
      "CREATE TRIGGER interrupt_imap_checkpoint BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(FAIL,'synthetic checkpoint interruption'); END",
    );
    await expect(
      runToCompletion(db, connector, IMAP_CONNECTOR_ID, source, "sync"),
    ).rejects.toThrow("synthetic checkpoint interruption");
    expect(getCheckpoint(db, IMAP_CONNECTOR_ID, source)).toBeNull();
    expect(liveIds(db)).toHaveLength(3);
    db.close();

    const resumed = await reopen(root, database, server, source);
    db = resumed.db;
    db.exec("DROP TRIGGER IF EXISTS interrupt_imap_checkpoint");
    const replayed = await runToCompletion(
      db,
      resumed.connector,
      IMAP_CONNECTOR_ID,
      source,
      "sync",
    );
    expect(replayed.errors).toEqual([]);
    expect(replayed.stored).toBe(0);
    expect(replayed.duplicates).toBe(3);
    expect(liveIds(db)).toEqual(["5:1:INBOX", "5:2:INBOX", "5:3:INBOX"]);
  } finally {
    db.close();
  }
});
