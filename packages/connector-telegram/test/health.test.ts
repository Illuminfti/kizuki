import { expect, test } from "bun:test";
import { HealthReport } from "@kizuki/core";
import { MAX_DIALOGS } from "../src/cursor";
import { TelegramConnector } from "../src/connector";
import {
  FIXTURE_CREDENTIALS,
  FIXTURE_OBSERVED_AT,
  FIXTURE_SESSION,
  fixtureAccount,
} from "../src/fixture";
import { ScriptedTelegramApi } from "../src/scripted";
import type { TelegramDialog } from "../src/api";
import {
  STATE_REF,
  connected,
  drain,
  harness,
  rejection,
  stateResolver,
} from "./helpers";

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

test("a chat the account stopped listing does not degrade health", async () => {
  const built = await connected();
  const drained = await drain(built.connector, "backfill");
  expect((await built.connector.health()).state).toBe("ok");

  // Leaving or deleting a chat is an ordinary act. Nothing the owner can do
  // would clear a report of it, so reporting it would pin the connection to
  // degraded for the rest of its life, and name the peer while doing so.
  built.api.hideDialog("-42");
  for (let pass = 0; pass < 3; pass += 1) {
    await built.connector.sync(drained.cursor);
    const report = await built.connector.health();
    expect(report.state).toBe("ok");
    expect(report.detail).toBeUndefined();
  }
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

test("a wait reported while listing dialogs is recorded and reported", async () => {
  const built = await connected();
  built.api.floodListing(300);

  // The first request of a fresh backfill is the listing, and it is the one
  // most likely to be told to wait on a large account. Nothing was read, so
  // there is no batch to hand back and no cursor to resume from: the caller
  // is told about the pause instead.
  const waiting = await rejection(() => built.connector.backfill(null));
  expect(waiting.code).toBe("flood_wait");
  expect(waiting.retry_after).toBe(300);

  const report = await built.connector.health();
  expect(report.state).toBe("rate_limited");
  expect(report.detail).toBe("retry after 300s");

  built.clock.now += 300_000;
  const resumed = await built.connector.backfill(null);
  expect(resumed.events).toHaveLength(12);
});

test("a wait reported by the authorization probe is a pause, not an outage", async () => {
  const built = await connected();
  built.api.floodProbe(300);

  const limited = await built.connector.health();
  expect(limited.state).toBe("rate_limited");
  expect(limited.detail).toBe("retry after 300s");

  // The wait was recorded, not merely rendered: a second report answers from
  // what the first one learned rather than spending another request into it.
  built.api.calls.length = 0;
  expect((await built.connector.health()).state).toBe("rate_limited");
  expect(built.api.calls).toEqual([]);

  built.clock.now += 300_000;
  expect((await built.connector.health()).state).toBe("ok");
});

test("revoke without a live client refuses rather than claiming access ended", async () => {
  const built = harness();

  // The stored session is still authorized at Telegram; nothing here could
  // have ended it, so a host must not be handed a revocation to record.
  const refused = await rejection(() => built.connector.revoke());
  expect(refused.code).toBe("missing_session");
  expect(built.api.calls).toEqual([]);

  const report = await built.connector.health();
  expect(report.state).toBe("unauthenticated");
  expect(report.detail).toBe("connect() has not been called");
});

test("a revoked connector reads nothing further", async () => {
  const built = await connected();
  const first = await built.connector.backfill(null);
  await built.connector.revoke();
  built.api.calls.length = 0;

  for (const attempt of [
    () => built.connector.backfill(null),
    () => built.connector.sync(first.cursor),
    () => built.connector.connect(stateResolver()),
  ]) {
    expect((await rejection(attempt)).code).toBe("unauthenticated");
  }
  // Not one request was attempted: a revoked instance is finished, not idle.
  expect(built.api.calls).toEqual([]);

  const report = await built.connector.health();
  expect(report.state).toBe("unauthenticated");
  expect(report.detail).toBe("access was revoked");
});

/** A client whose teardown faults the way a library one can. */
class BrittleTeardown extends ScriptedTelegramApi {
  override async disconnect(): Promise<void> {
    throw new TypeError("cannot read properties of undefined");
  }
}

test("a client that will not close still leaves the connection ended", async () => {
  const api = new BrittleTeardown(fixtureAccount(), FIXTURE_SESSION);
  const connector = new TelegramConnector(
    { state_ref: STATE_REF },
    {
      api: () => api,
      credentials: () => FIXTURE_CREDENTIALS,
      now: () => Date.parse(FIXTURE_OBSERVED_AT),
      sleep: async () => {},
    },
  );
  await connector.connect(stateResolver());

  // Telegram accepted the sign-out, so access really did end. Handing the host
  // the teardown fault instead would have it record a revocation that failed,
  // and a retry would find the instance still holding the client.
  await connector.revoke();
  const report = await connector.health();
  expect(report.state).toBe("unauthenticated");
  expect(report.detail).toBe("access was revoked");
  expect((await rejection(() => connector.backfill(null))).code).toBe(
    "unauthenticated",
  );
});
