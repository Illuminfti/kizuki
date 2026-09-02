import { expect, test } from "bun:test";
import { fixtureAccount } from "../src/scripted";
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
