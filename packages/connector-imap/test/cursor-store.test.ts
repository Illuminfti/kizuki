import { expect, setDefaultTimeout, test } from "bun:test";
import {
  MAX_CURSOR_BYTES,
  MAX_CURSOR_STORE_BYTES,
  getCheckpoint,
  readCursorStore,
  registerConnection,
  runBackfill,
  runToCompletion,
  setSourceGrant,
} from "@kizuki/core";
import type { CaptureEventInput, Connector, SyncBatch } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { IMAP_CONNECTOR_ID, createImapConnector } from "../src/connector";
import { DEFAULT_MAX_MESSAGE_BYTES, serializeImapState } from "../src/state";
import type { ImapState } from "../src/state";
import { FakeImapServer } from "../src/testing/fake-imap";
import type { FakeMessage } from "../src/testing/fake-imap";
import { memoryDialer } from "../src/testing";

// Real ledger work over thousands of messages; bound it for a loaded host.
setDefaultTimeout(600_000);

const SOURCE = "01JJ0000000000000000000000";
const NOW = (): Date => new Date("2026-03-02T00:00:00.000Z");
const encoder = new TextEncoder();
const STATE: ImapState = {
  schema: "kizuki.imap-state/v1",
  host: "mail.acme.example",
  port: 993,
  username: "ada@acme.example",
  password: "app-password",
  folders: ["INBOX"],
  max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
};

function message(uid: number, internaldate = "01-Mar-2026 08:00:00 +0000"): FakeMessage {
  return {
    uid,
    internaldate,
    raw: encoder.encode(
      [
        "From: Ada <ada@acme.example>",
        "To: grace@acme.example",
        `Subject: note ${uid}`,
        "Date: Sun, 01 Mar 2026 08:00:00 +0000",
        `Message-ID: <${uid}@acme.example>`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        `n${uid}`,
        "",
      ].join("\r\n"),
    ),
  };
}

/** A mailbox whose UIDs run 1..space and where only `present` ones still exist. */
function mailbox(space: number, present: (uid: number) => boolean): FakeImapServer {
  const messages: FakeMessage[] = [];
  for (let uid = 1; uid <= space; uid += 1) if (present(uid)) messages.push(message(uid));
  return new FakeImapServer([
    { wire: "INBOX", attributes: ["\\HasNoChildren"], uidvalidity: 5, uidnext: space + 1, messages },
  ]);
}

async function connectorFor(server: FakeImapServer, state: ImapState = STATE) {
  const connector = createImapConnector(
    { secret_ref: "file:connections/01JJ0000000000000000000000.state" },
    { dial: memoryDialer(server), now: NOW },
  );
  await connector.connect(async () => new TextDecoder().decode(serializeImapState(state)));
  return connector;
}

function ledger() {
  const db = openLedger(":memory:");
  registerConnection(db, IMAP_CONNECTOR_ID, SOURCE);
  setSourceGrant(db, {
    source_key: SOURCE,
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
  return db;
}

const bytes = (text: string | null | undefined): number => encoder.encode(text ?? "").byteLength;

test("a fragmented mailbox backfills through the real ledger and resumes on a fresh connector", async () => {
  // Every other UID is gone: the seen set is one range per message.
  const server = mailbox(4_400, (uid) => uid % 2 === 1);
  const db = ledger();

  const first = await runBackfill(db, await connectorFor(server), IMAP_CONNECTOR_ID, SOURCE);
  expect(first.errors).toEqual([]);
  expect(first.stored).toBe(200);

  const rest = await runToCompletion(db, await connectorFor(server), IMAP_CONNECTOR_ID, SOURCE, "backfill");
  expect(rest.errors).toEqual([]);
  expect(rest.duplicates).toBe(0);
  expect(first.stored + rest.stored).toBe(2_200);

  const checkpoint = getCheckpoint(db, IMAP_CONNECTOR_ID, SOURCE);
  expect(checkpoint?.backfill_complete).toBe(true);
  expect(bytes(checkpoint?.backfill_cursor)).toBeLessThan(MAX_CURSOR_BYTES);
  // The seen set no longer fits a checkpoint; it sits beside it instead.
  const held = readCursorStore(db, IMAP_CONNECTOR_ID, SOURCE).get("folder:INBOX") ?? "";
  expect(bytes(held)).toBeGreaterThan(MAX_CURSOR_BYTES);
  expect(bytes(held)).toBeLessThan(MAX_CURSOR_STORE_BYTES);

  // A later sync on yet another process sees nothing new and repeats nothing.
  const synced = await runToCompletion(db, await connectorFor(server), IMAP_CONNECTOR_ID, SOURCE, "sync");
  expect(synced.errors).toEqual([]);
  expect(synced.stored).toBe(0);
  expect(synced.duplicates).toBe(0);
  db.close();
});

test("20,000 UIDs with 30 percent gaps backfill and resume inside the bound", async () => {
  const server = mailbox(20_000, (uid) => uid % 10 < 7);
  const db = ledger();

  // The ledger's own cost per event is not what this measures, so the events
  // are counted and dropped; the checkpoint, the bound and the side map are
  // the host's real ones.
  const seen = new Set<string>();
  let emitted = 0;
  const counting = (inner: Connector): Connector => {
    const drop = async (batch: Promise<SyncBatch>): Promise<SyncBatch> => {
      const { events, ...rest } = await batch;
      for (const event of events as CaptureEventInput[]) {
        emitted += 1;
        seen.add(event.source_record_id);
      }
      return { ...rest, events: [] };
    };
    return {
      manifest: () => inner.manifest(),
      health: () => inner.health(),
      connect: (resolve) => inner.connect(resolve),
      backfill: (cursor, context) => drop(inner.backfill(cursor, context)),
      sync: (cursor, context) => drop(inner.sync(cursor, context)),
      revoke: () => inner.revoke(),
      purgeSource: (subject) => inner.purgeSource(subject),
      fixture: () => inner.fixture(),
    };
  };

  // Ten batches, then a new process for the rest.
  for (let batch = 0; batch < 10; batch += 1) {
    const step = await runBackfill(db, counting(await connectorFor(server)), IMAP_CONNECTOR_ID, SOURCE);
    expect(step.errors).toEqual([]);
  }
  const midway = getCheckpoint(db, IMAP_CONNECTOR_ID, SOURCE);
  expect(midway?.backfill_complete).toBe(false);
  expect(bytes(midway?.backfill_cursor)).toBeLessThan(MAX_CURSOR_BYTES);

  const rest = await runToCompletion(db, counting(await connectorFor(server)), IMAP_CONNECTOR_ID, SOURCE, "backfill");
  expect(rest.errors).toEqual([]);
  expect(emitted).toBe(14_000);
  expect(seen.size).toBe(14_000);

  const checkpoint = getCheckpoint(db, IMAP_CONNECTOR_ID, SOURCE);
  expect(checkpoint?.backfill_complete).toBe(true);
  expect(bytes(checkpoint?.backfill_cursor)).toBeLessThan(MAX_CURSOR_BYTES);
  const held = readCursorStore(db, IMAP_CONNECTOR_ID, SOURCE).get("folder:INBOX") ?? "";
  expect(bytes(held)).toBeGreaterThan(MAX_CURSOR_BYTES);
  expect(bytes(held)).toBeLessThan(MAX_CURSOR_STORE_BYTES);

  // Nothing was expunged, so a sync from a fresh connector emits nothing.
  const synced = await runToCompletion(db, counting(await connectorFor(server)), IMAP_CONNECTOR_ID, SOURCE, "sync");
  expect(synced.errors).toEqual([]);
  expect(emitted).toBe(14_000);
  db.close();
});
