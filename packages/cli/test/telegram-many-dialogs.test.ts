import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  ConnectionStateStore,
  MAX_CURSOR_BYTES,
  getCheckpoint,
  listConnections,
  readCursorStore,
  runBackfill,
  runToCompletion,
  setSourceGrant,
} from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import {
  FIXTURE_CREDENTIALS,
  ScriptedTelegramApi,
  TelegramConnector,
  fixtureAccount,
} from "@kizuki/connector-telegram";
import type { TelegramDialog, TelegramMessage } from "@kizuki/connector-telegram";
import { runTelegramConnect } from "../src/commands/connect-telegram";
import { loadConnector, selectConnection } from "../src/connections";
import type { CliIo } from "../src/commands";
import { createHelpers } from "./helpers";

const h = createHelpers();
afterEach(h.cleanup);
setDefaultTimeout(300_000);

function account(dialogCount: number) {
  const dialogs: TelegramDialog[] = [];
  const messages: Record<string, TelegramMessage[]> = {};
  for (let index = 0; index < dialogCount; index += 1) {
    const peer = String(200_000 + index);
    dialogs.push({ peer_id: peer, peer_type: "user", title: `chat ${index}`, top_message_id: 2 });
    messages[peer] = [1, 2].map((id) => ({
      peer_id: peer, id, date: 1_767_225_600 + id, text: `hello ${index} ${id}`, out: false, service: false,
    }));
  }
  return fixtureAccount({ dialogs, messages });
}

// The account the first version of the cursor could not hold: about 72 bytes a
// dialog against a checkpoint bound of 8 KiB stopped storing anything at 125.
test("a 260-dialog account backfills through the host and resumes on a fresh connector", async () => {
  const setup = h.tempVault();
  const scripted = account(260);
  const answers = ["+15551234567", "22222"];
  const io: CliIo = {
    env: setup.env, vaultOverride: setup.vault, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true,
    out: () => {}, err: () => {}, prompt: async () => answers.shift() ?? "22222",
  };
  const scriptedConnector = () =>
    new TelegramConnector({}, { api: () => new ScriptedTelegramApi(scripted), credentials: () => FIXTURE_CREDENTIALS, sleep: async () => {} });
  await runTelegramConnect(io, { json: true }, () => {}, scriptedConnector);

  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  const store = new ConnectionStateStore(join(setup.vault, ".kizuki"));
  try {
    const row = listConnections(db)[0]!;
    setSourceGrant(db, {
      source_key: row.source_key, expected_revision: 0, operation_id: "grant",
      policy: {
        purposes: ["capture"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
      },
    });
    const load = () =>
      loadConnector(
        selectConnection(db, store, "kizuki.telegram", row.source_key), store, db, {},
        (_id, config, deps) => new TelegramConnector(config as { state_ref: string }, { ...deps, api: () => new ScriptedTelegramApi(scripted), credentials: () => FIXTURE_CREDENTIALS }),
      );

    // One batch, then a new process for the rest.
    const first = await runBackfill(db, await load(), "kizuki.telegram", row.source_key, { vault_path: setup.vault });
    expect(first.errors).toEqual([]);
    expect(first.stored).toBe(500);
    expect(getCheckpoint(db, "kizuki.telegram", row.source_key)?.backfill_complete).toBe(false);

    const rest = await runToCompletion(db, await load(), "kizuki.telegram", row.source_key, "backfill", { vault_path: setup.vault });
    expect(rest.errors).toEqual([]);
    expect(rest.stored).toBe(20);
    expect(rest.duplicates).toBe(0);
    expect(getCheckpoint(db, "kizuki.telegram", row.source_key)?.backfill_complete).toBe(true);

    const checkpoint = getCheckpoint(db, "kizuki.telegram", row.source_key);
    expect(new TextEncoder().encode(checkpoint?.backfill_cursor ?? "").byteLength).toBeLessThan(MAX_CURSOR_BYTES);
    expect(readCursorStore(db, "kizuki.telegram", row.source_key).size).toBe(260);
  } finally {
    db.close();
  }
});
