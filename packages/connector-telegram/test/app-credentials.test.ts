import { expect, test } from "bun:test";
import {
  PLACEHOLDER_CREDENTIALS_MESSAGE,
  appCredentials,
  requireAppCredentials,
} from "../src/app-credentials";
import { TelegramConnectorError } from "../src/api";
import { TelegramConnector } from "../src/connector";
import { ScriptedTelegramApi, fixtureAccount } from "../src/scripted";
import {
  CapturingWriter,
  STATE_REF,
  ScriptedIo,
  rejection,
  stateResolver,
} from "./helpers";

function unbuilt(config: { state_ref?: string }): {
  connector: TelegramConnector;
  api: ScriptedTelegramApi;
} {
  const api = new ScriptedTelegramApi(fixtureAccount());
  return {
    connector: new TelegramConnector(config, {
      api: () => api,
      credentials: () => null,
    }),
    api,
  };
}

test("placeholder values yield no credentials", () => {
  expect(appCredentials({ api_id: "0", api_hash: "" })).toBeNull();
  expect(appCredentials({ api_id: "0", api_hash: "cafe" })).toBeNull();
  expect(appCredentials({ api_id: "12", api_hash: "" })).toBeNull();
});

test("a malformed app id yields no credentials", () => {
  expect(appCredentials({ api_id: "abc", api_hash: "cafe" })).toBeNull();
  expect(appCredentials({ api_id: "-5", api_hash: "cafe" })).toBeNull();
  expect(appCredentials({ api_id: "1.5", api_hash: "cafe" })).toBeNull();
  expect(appCredentials({ api_id: "", api_hash: "cafe" })).toBeNull();
  expect(
    appCredentials({ api_id: "99999999999999999999", api_hash: "cafe" }),
  ).toBeNull();
});

test("a registered pair yields credentials", () => {
  expect(appCredentials({ api_id: "12345", api_hash: "cafe" })).toEqual({
    api_id: 12345,
    api_hash: "cafe",
  });
});

test("requiring credentials fails closed with the documented message", () => {
  let thrown: unknown;
  try {
    requireAppCredentials(() => null);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TelegramConnectorError);
  expect((thrown as TelegramConnectorError).code).toBe(
    "placeholder_credentials",
  );
  expect((thrown as TelegramConnectorError).message).toBe(
    PLACEHOLDER_CREDENTIALS_MESSAGE,
  );
});

test("sign-in refuses before a single prompt when credentials are placeholders", async () => {
  const { connector, api } = unbuilt({});
  const io = new ScriptedIo(["+15551234567"]);
  const error = await rejection(() => connector.signIn(io, new CapturingWriter()));
  expect(error.code).toBe("placeholder_credentials");
  expect(error.message).toBe(PLACEHOLDER_CREDENTIALS_MESSAGE);
  expect(io.prompts).toEqual([]);
  expect(api.calls).toEqual([]);
});

test("connect refuses without reaching the provider when credentials are placeholders", async () => {
  const { connector, api } = unbuilt({ state_ref: STATE_REF });
  const error = await rejection(() => connector.connect(stateResolver()));
  expect(error.code).toBe("placeholder_credentials");
  expect(error.message).toBe(PLACEHOLDER_CREDENTIALS_MESSAGE);
  expect(api.calls).toEqual([]);
});
