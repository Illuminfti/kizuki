import { expect, test } from "bun:test";
import { DEFAULT_GRANT, resolveSensitivity, setSourceGrant, registerConnection, runToCompletion } from "@kizuki/core";
import { openLedger, timeline } from "@kizuki/core/testing";
import { TelegramConnector } from "../src/connector";
import { TELEGRAM_CONNECTOR_ID } from "../src/map";
import { scriptedDeps } from "../src/scripted";
import { connected } from "./helpers";

const FEBRUARY = Date.parse("2026-02-01T00:00:00.000Z");
const SOURCE = "01JJ0000000000000000000000";

function ledger() {
  const db = openLedger(":memory:");
  registerConnection(db, TELEGRAM_CONNECTOR_ID, SOURCE);
  // Explicit synthetic owner consent; keep connector sensitivity authoritative.
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

/**
 * Telegram is a chat source, and RFC 0002 §8.2 puts that class at a `private`
 * default: what the owner reads and writes in their own dialogs is not
 * evidence an agent holding the default grant may be handed. The hint is the
 * only label anything downstream has today, so it is the whole of the
 * defence.
 */
test("nothing this connector captured is served under the default agent ceiling", async () => {
  const built = await connected({ now: FEBRUARY });
  const db = ledger();
  const stored = await runToCompletion(
    db,
    built.connector,
    TELEGRAM_CONNECTOR_ID,
    SOURCE,
    "backfill",
  );
  expect(stored.stored).toBe(12);

  expect(
    timeline(db, { connector_id: TELEGRAM_CONNECTOR_ID, ceiling: DEFAULT_GRANT.ceiling }),
  ).toEqual([]);
  // And it is withheld because it is labeled, not because it is missing.
  expect(
    timeline(db, { connector_id: TELEGRAM_CONNECTOR_ID, ceiling: "private" }),
  ).toHaveLength(12);
  db.close();
});

/** The direct-messaging class policy (RFC 0002 §8.2), read off the manifest core seals. */
test("the manifest declares a private default over a personal floor", () => {
  const manifest = new TelegramConnector({}, scriptedDeps()).manifest();
  expect(manifest.default_sensitivity).toBe("private");
  expect(manifest.sensitivity_floor).toBe("personal");
});

test("a public hint on an event is honoured only upward, never below the manifest policy", () => {
  const manifest = new TelegramConnector({}, scriptedDeps()).manifest();
  const resolved = resolveSensitivity({
    connector_floor: manifest.sensitivity_floor,
    connector_default: manifest.default_sensitivity,
    event_hint: "public",
  });
  expect(resolved.sensitivity).toBe("private");
  expect(resolved.hint_ignored).toBe(true);
});
