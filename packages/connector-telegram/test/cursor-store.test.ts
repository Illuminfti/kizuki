import { expect, test } from "bun:test";
import {
  CONNECTOR_OPERATION_DEADLINE_MS,
  MAX_CURSOR_BYTES,
  getCheckpoint,
  readCursorStore,
  registerConnection,
  runBackfill,
  runToCompletion,
  setSourceGrant,
} from "@kizuki/core";
import type { Connector, SyncBatch } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { decodeDialogs } from "../src/cursor";
import { fixtureAccount } from "../src/fixture";
import type { ScriptedAccount } from "../src/fixture";
import { TELEGRAM_CONNECTOR_ID } from "../src/map";
import { connected } from "./helpers";

const SOURCE = "01JJ0000000000000000000000";
const FEBRUARY = Date.parse("2026-02-01T00:00:00.000Z");
const EPOCH = Math.floor(FEBRUARY / 1000);

function ledger() {
  const db = openLedger(":memory:");
  registerConnection(db, TELEGRAM_CONNECTOR_ID, SOURCE);
  setSourceGrant(db, {
    source_key: SOURCE, expected_revision: 0, operation_id: "fixture-grant",
    policy: {
      purposes: ["capture", "recall", "derive"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only",
      sensitivity_floor: "public",
    },
  });
  return db;
}

/** `count` private chats with `perDialog` messages each. */
function crowded(count: number, perDialog: number): ScriptedAccount {
  const account = fixtureAccount();
  account.dialogs = [];
  account.messages = {};
  for (let index = 0; index < count; index += 1) {
    const peer_id = String(200_000 + index);
    account.dialogs.push({ peer_id, peer_type: "user", title: `chat ${index}`, top_message_id: perDialog });
    account.messages[peer_id] = Array.from({ length: perDialog }, (_, offset) => ({
      peer_id, id: offset + 1, date: EPOCH + offset, text: `hello ${index} ${offset}`, out: false, service: false,
    }));
  }
  return account;
}

for (const [count, perDialog] of [[200, 3], [1_000, 1], [5_000, 1]] as const) {
  test(`a ${count}-dialog account backfills, checkpoints under the bound, resumes on a fresh connector and syncs clean`, async () => {
    const built = await connected({ account: crowded(count, perDialog), now: FEBRUARY });
    const db = ledger();

    // One batch, then a new process: the map has to come from the host.
    const started = await runBackfill(db, built.connector, TELEGRAM_CONNECTOR_ID, SOURCE);
    expect(started.errors).toEqual([]);
    expect(started.stored).toBe(500);
    const first = getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.backfill_cursor as string;
    expect(new TextEncoder().encode(first).byteLength).toBeLessThan(MAX_CURSOR_BYTES);

    const rest = await runToCompletion(db, await built.restart(), TELEGRAM_CONNECTOR_ID, SOURCE, "backfill");
    expect(rest.errors).toEqual([]);
    expect(rest.duplicates).toBe(0);
    expect(started.stored + rest.stored).toBe(count * perDialog);

    const checkpoint = getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE);
    expect(checkpoint?.backfill_complete).toBe(true);
    expect(new TextEncoder().encode(checkpoint?.backfill_cursor ?? "").byteLength).toBeLessThan(MAX_CURSOR_BYTES);
    const dialogs = decodeDialogs(readCursorStore(db, TELEGRAM_CONNECTOR_ID, SOURCE));
    expect(Object.keys(dialogs)).toHaveLength(count);
    expect(Object.values(dialogs).every((dialog) => dialog.exhausted && dialog.last_id === perDialog)).toBe(true);

    // The settled account, on yet another process: nothing new, nothing repeated.
    built.clock.now += 3_600_000;
    const synced = await runToCompletion(db, await built.restart(), TELEGRAM_CONNECTOR_ID, SOURCE, "sync");
    expect(synced.errors).toEqual([]);
    expect(synced.stored).toBe(0);
    expect(synced.duplicates).toBe(0);
    expect(Object.keys(decodeDialogs(readCursorStore(db, TELEGRAM_CONNECTOR_ID, SOURCE)))).toHaveLength(count);
    db.close();
  }, 900_000);
}

test("100 ms per call over 400 dialogs takes several batches, each inside the host deadline", async () => {
  const built = await connected({ account: crowded(400, 1), now: FEBRUARY });
  const db = ledger();
  const backfilled = await runToCompletion(db, built.connector, TELEGRAM_CONNECTOR_ID, SOURCE, "backfill");
  expect(backfilled.errors).toEqual([]);
  expect(backfilled.stored).toBe(400);

  // Every provider call now costs 100 ms of a clock only this test advances. A
  // settled account's sync pass makes about two calls a dialog: 80 s of
  // provider time in all, which one batch of the host's 60 s cannot hold.
  built.api.latency(100, async (ms) => { built.clock.now += ms; });
  const measured: number[] = [];
  const timed = async (run: () => Promise<SyncBatch>): Promise<SyncBatch> => {
    const began = built.clock.now;
    try { return await run(); } finally { measured.push(built.clock.now - began); }
  };
  const meter: Connector = {
    manifest: () => built.connector.manifest(),
    health: () => built.connector.health(),
    connect: (resolve) => built.connector.connect(resolve),
    backfill: (cursor, context) => timed(() => built.connector.backfill(cursor, context)),
    sync: (cursor, context) => timed(() => built.connector.sync(cursor, context)),
    revoke: () => built.connector.revoke(),
    purgeSource: (subject) => built.connector.purgeSource(subject),
    fixture: () => built.connector.fixture(),
  };

  built.clock.now += 3_600_000;
  const synced = await runToCompletion(db, meter, TELEGRAM_CONNECTOR_ID, SOURCE, "sync");
  expect(synced.errors).toEqual([]);
  expect(synced.stored).toBe(0);
  expect(synced.duplicates).toBe(0);
  expect(measured.length).toBeGreaterThan(1);
  for (const elapsed of measured) expect(elapsed).toBeLessThan(CONNECTOR_OPERATION_DEADLINE_MS);
  const dialogs = decodeDialogs(readCursorStore(db, TELEGRAM_CONNECTOR_ID, SOURCE));
  expect(Object.keys(dialogs)).toHaveLength(400);
  expect(getCheckpoint(db, TELEGRAM_CONNECTOR_ID, SOURCE)?.sync_cursor).not.toBeNull();
  db.close();
}, 300_000);
