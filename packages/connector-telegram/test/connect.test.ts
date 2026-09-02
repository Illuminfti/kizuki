import { expect, test } from "bun:test";
import {
  ScriptedTelegramApi,
} from "../src/scripted";
import {
  FIXTURE_CREDENTIALS,
  FIXTURE_OBSERVED_AT,
  fixtureAccount,
} from "../src/fixture";
import { TelegramConnector } from "../src/connector";
import {
  STATE_REF,
  harness,
  rejection,
  stateResolver,
  stateText,
} from "./helpers";

test("a connector with no state reference refuses to connect", async () => {
  const { connector, api } = harness({ config: {} });
  const error = await rejection(() => connector.connect(stateResolver()));
  expect(error.code).toBe("missing_session");
  expect(error.message).toBe(
    "kizuki.telegram: not signed in; run: kizuki connect telegram",
  );
  expect(api.calls).toEqual([]);
});

test("a state reference the host did not mint is refused at construction", () => {
  for (const ref of [
    "file:connections/not-a-ulid.state",
    "env:TELEGRAM_SESSION",
    "file:connections/01JJ0000000000000000000000.state.bak",
    42,
  ]) {
    expect(() =>
      harness({ config: { state_ref: ref as string } }),
    ).toThrow("kizuki.telegram: connection state reference is not a core-minted ref");
  }
});

test("a resolver that refuses leaves the connector unsigned-in", async () => {
  const { connector, api } = harness();
  const error = await rejection(() =>
    connector.connect(async () => {
      throw new Error("no such secret");
    }),
  );
  expect(error.code).toBe("missing_session");
  expect(api.calls).toEqual([]);
});

test("an unreadable state blob is corrupt state", async () => {
  const { connector, api } = harness();
  const error = await rejection(() =>
    connector.connect(async (ref) => {
      expect(ref).toBe(STATE_REF);
      return "{}";
    }),
  );
  expect(error.code).toBe("corrupt_state");
  expect(api.calls).toEqual([]);
});

test("a session the account has signed out is unauthenticated", async () => {
  const account = fixtureAccount({ authorized: false });
  const { connector, api } = harness({ account });
  const error = await rejection(() => connector.connect(stateResolver()));
  expect(error.code).toBe("unauthenticated");
  expect(api.calls.map((call) => call.method)).toEqual([
    "connect",
    "isAuthorized",
    "disconnect",
  ]);
});

test("a session belonging to another account is refused", async () => {
  const { connector, api } = harness();
  const error = await rejection(() =>
    connector.connect(stateResolver(stateText("2002"))),
  );
  expect(error.code).toBe("identity_mismatch");
  expect(error.message).toBe(
    "kizuki.telegram: signed-in account does not match the stored connection",
  );
  expect(api.calls.map((call) => call.method)).toEqual([
    "connect",
    "isAuthorized",
    "me",
    "disconnect",
  ]);
});

test("connecting with the matching account never starts a login flow", async () => {
  const { connector, api } = harness();
  await connector.connect(stateResolver());
  expect(api.calls.map((call) => call.method)).toEqual([
    "connect",
    "isAuthorized",
    "me",
  ]);
});

test("connecting again lets go of the client it replaces", async () => {
  const built: ScriptedTelegramApi[] = [];
  const connector = new TelegramConnector(
    { state_ref: STATE_REF },
    {
      api: () => {
        const api = new ScriptedTelegramApi(fixtureAccount());
        built.push(api);
        return api;
      },
      credentials: () => FIXTURE_CREDENTIALS,
      now: () => Date.parse(FIXTURE_OBSERVED_AT),
      sleep: async () => {},
    },
  );

  await connector.connect(stateResolver());
  await connector.connect(stateResolver());
  expect(built).toHaveLength(2);
  // Re-authentication keeps the same connection, so the socket the first
  // client is holding has to be handed back rather than abandoned.
  expect(built[0]?.calls.map((call) => call.method)).toContain("disconnect");
  expect(built[1]?.calls.map((call) => call.method)).not.toContain("disconnect");
});

test("a failed reconnect does not tear down the connection that works", async () => {
  const { connector, api } = harness();
  await connector.connect(stateResolver());
  const error = await rejection(() => connector.connect(async () => "{}"));
  expect(error.code).toBe("corrupt_state");
  expect(api.calls.map((call) => call.method)).not.toContain("disconnect");
  expect((await connector.health()).state).toBe("ok");
});

/** A connector whose every `connect` builds a fresh client, as re-auth does. */
function reconnecting(accounts: (() => ScriptedTelegramApi)[]) {
  const built: ScriptedTelegramApi[] = [];
  let index = 0;
  const connector = new TelegramConnector(
    { state_ref: STATE_REF },
    {
      api: () => {
        const make = accounts[Math.min(index, accounts.length - 1)];
        index += 1;
        const api = (make as () => ScriptedTelegramApi)();
        built.push(api);
        return api;
      },
      credentials: () => FIXTURE_CREDENTIALS,
      now: () => Date.parse(FIXTURE_OBSERVED_AT),
      sleep: async () => {},
    },
  );
  return { connector, built };
}

function unreachableApi(): ScriptedTelegramApi {
  const api = new ScriptedTelegramApi(fixtureAccount());
  api.disconnectNetwork();
  return api;
}

test("a reconnect that cannot reach telegram keeps the live connection", async () => {
  const { connector, built } = reconnecting([
    () => new ScriptedTelegramApi(fixtureAccount()),
    unreachableApi,
  ]);
  await connector.connect(stateResolver());

  const error = await rejection(() => connector.connect(stateResolver()));
  expect(error.code).toBe("unreachable");
  // The replacement never proved itself, so the client that works is still
  // the one the connector holds.
  expect(built[0]?.calls.map((call) => call.method)).not.toContain("disconnect");
  expect((await connector.health()).state).toBe("ok");
});

test("a reconnect answered by another account keeps the live connection", async () => {
  const { connector, built } = reconnecting([
    () => new ScriptedTelegramApi(fixtureAccount()),
    () =>
      new ScriptedTelegramApi(
        fixtureAccount({ me: { id: "2002", username: "linus", bot: false } }),
      ),
  ]);
  await connector.connect(stateResolver());

  const error = await rejection(() => connector.connect(stateResolver()));
  expect(error.code).toBe("identity_mismatch");
  expect(built[0]?.calls.map((call) => call.method)).not.toContain("disconnect");
  expect(built[1]?.calls.map((call) => call.method)).toContain("disconnect");
  expect((await connector.health()).state).toBe("ok");
});

test("a reconnect to a session signed out elsewhere keeps the live connection", async () => {
  const { connector, built } = reconnecting([
    () => new ScriptedTelegramApi(fixtureAccount()),
    () => new ScriptedTelegramApi(fixtureAccount({ authorized: false })),
  ]);
  await connector.connect(stateResolver());

  const error = await rejection(() => connector.connect(stateResolver()));
  expect(error.code).toBe("unauthenticated");
  expect(built[0]?.calls.map((call) => call.method)).not.toContain("disconnect");
  expect((await connector.health()).state).toBe("ok");
});

test("connecting again over one client does not hang up on it", async () => {
  const { connector, api } = harness();
  await connector.connect(stateResolver());
  await connector.connect(stateResolver());
  // A host whose factory hands back the client it already built is handing
  // back the live one; letting go of it would close the connection just made.
  expect(api.calls.map((call) => call.method)).not.toContain("disconnect");
  expect((await connector.health()).state).toBe("ok");
});
