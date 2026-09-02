import { expect, test } from "bun:test";
import { HealthReport } from "@kizuki/core";
import { MAX_DIALOGS } from "../src/cursor";
import {
  fixtureAccount,
} from "../src/fixture";
import type { TelegramDialog } from "../src/api";
import { connected, drain, harness, stateResolver } from "./helpers";

test("health tracks the connection from unsigned to revoked", async () => {
  const unsigned = harness({ config: {} });
  const disabled = await unsigned.connector.health();
  expect(disabled).toBeInstanceOf(HealthReport);
  expect(disabled.state).toBe("disabled");

  const built = harness();
  const beforeConnect = await built.connector.health();
  expect(beforeConnect.state).toBe("unauthenticated");
  expect(beforeConnect.detail).toBe("connect() has not been called");

  await built.connector.connect(stateResolver());
  const ok = await built.connector.health();
  expect(ok.state).toBe("ok");
  expect(ok.last_success_at).toBe("2026-01-01T00:00:00.000Z");

  built.api.disconnectNetwork();
  expect((await built.connector.health()).state).toBe("unreachable");
});

test("a wait reported mid-walk shows as rate limited until it lapses", async () => {
  const account = fixtureAccount();
  account.flood = { after_calls: 0, seconds: 45 };
  const built = await connected({ account });

  await built.connector.backfill(null);
  const limited = await built.connector.health();
  expect(limited.state).toBe("rate_limited");
  expect(limited.detail).toBe("retry after 45s");

  built.clock.now += 45_000;
  expect((await built.connector.health()).state).toBe("ok");
});

test("a session revoked elsewhere reports as unauthenticated", async () => {
  const built = await connected();
  built.api.revoke();
  const report = await built.connector.health();
  expect(report.state).toBe("unauthenticated");
});

test("revoking ends access and health says so", async () => {
  const built = await connected();
  await built.connector.revoke();
  expect(built.api.calls.map((call) => call.method)).toContain("logOut");
  const report = await built.connector.health();
  expect(report.state).toBe("unauthenticated");
  expect(report.detail).toBe("access was revoked");
});

test("revoke that cannot reach telegram does not claim access ended", async () => {
  const built = await connected();
  built.api.disconnectNetwork();
  let thrown: unknown;
  try {
    await built.connector.revoke();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  expect((await built.connector.health()).state).toBe("unreachable");
});

test("hitting the dialog listing bound degrades health", async () => {
  const account = fixtureAccount();
  const dialogs: TelegramDialog[] = [];
  for (let index = 0; index < MAX_DIALOGS; index += 1) {
    dialogs.push({
      peer_id: String(9_000_000 + index),
      peer_type: "user",
      title: "grace",
      public: false,
      top_message_id: 0,
    });
  }
  account.dialogs = dialogs;
  account.messages = {};
  const built = await connected({ account });

  await built.connector.backfill(null);
  const report = await built.connector.health();
  expect(report.state).toBe("degraded");
  expect(report.detail).toBe(
    `dialog limit reached (${MAX_DIALOGS}); newest dialogs only`,
  );
});

test("health names the dialogs the account stopped listing", async () => {
  const built = await connected();
  const drained = await drain(built.connector, "backfill");
  expect((await built.connector.health()).state).toBe("ok");

  built.api.hideDialog("-42");
  await built.connector.sync(drained.cursor);

  const report = await built.connector.health();
  expect(report.state).toBe("degraded");
  expect(report.detail).toBe("dialogs the account no longer lists (1): -42");

  built.api.showDialogs();
  await built.connector.sync(drained.cursor);
  expect((await built.connector.health()).state).toBe("ok");
});

test("a pass cut short by a wait is not recorded as a success", async () => {
  const account = fixtureAccount();
  account.flood = { after_calls: 0, seconds: 45 };
  const built = await connected({ account });
  const connectedAt = (await built.connector.health()).last_success_at;
  expect(connectedAt).toBe("2026-01-01T00:00:00.000Z");

  built.clock.now += 60_000;
  await built.connector.backfill(null);
  const limited = await built.connector.health();
  expect(limited.state).toBe("rate_limited");
  // The instant the wait was reported is not a time anything succeeded at.
  expect(limited.last_success_at).toBe(connectedAt);

  built.clock.now += 45_000;
  await built.connector.backfill(null);
  const recovered = await built.connector.health();
  expect(recovered.state).toBe("ok");
  expect(recovered.last_success_at).toBe("2026-01-01T00:01:45.000Z");
});

test("a wait reported while listing dialogs is recorded, not raised", async () => {
  const built = await connected();
  built.api.floodListing(300);

  // The first request of a fresh backfill is the listing, and it is the one
  // most likely to be told to wait on a large account.
  const batch = await built.connector.backfill(null);
  expect(batch.events).toEqual([]);
  expect(batch.cursor).toBeNull();

  const report = await built.connector.health();
  expect(report.state).toBe("rate_limited");
  expect(report.detail).toBe("retry after 300s");

  built.clock.now += 300_000;
  const resumed = await built.connector.backfill(null);
  expect(resumed.events).toHaveLength(12);
});
