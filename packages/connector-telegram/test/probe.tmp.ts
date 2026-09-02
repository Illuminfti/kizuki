import { openLedger, runToCompletion } from "@kizuki/core";
import { initStaging } from "@kizuki/core/staging";
import { fixtureAccount } from "../src/fixture";
import type { TelegramMessage } from "../src/api";
import { TELEGRAM_CONNECTOR_ID } from "../src/map";
import { connected } from "./helpers";

function chatter(peer_id: string, from: number, to: number, service: boolean): TelegramMessage[] {
  const out: TelegramMessage[] = [];
  for (let id = from; id <= to; id += 1) {
    out.push({ peer_id, id, date: 1770000000 + id, text: service ? "" : `n${id}`, out: false, service });
  }
  return out;
}
const account = fixtureAccount();
account.dialogs = [{ peer_id: "1", peer_type: "user", title: "grace", top_message_id: 2005 }];
account.messages = { "1": [...chatter("1", 1, 2000, true), ...chatter("1", 2001, 2005, false)] };
const built = await connected({ account, now: Date.parse("2026-02-01T00:00:00.000Z") });
const db = openLedger(":memory:");
initStaging(db);
for (let i = 0; i < 4; i += 1) {
  built.api.floodAfter(2, 600);
  const result = await runToCompletion(db, built.connector, TELEGRAM_CONNECTOR_ID, "01JJ0000000000000000000000", "backfill");
  console.log(i, "stored", result.stored, "errors", result.errors, "cursor", result.cursor?.slice(0, 90));
  built.clock.now += 600_000;
}
