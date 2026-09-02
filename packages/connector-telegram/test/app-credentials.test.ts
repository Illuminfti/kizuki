import { expect, test } from "bun:test";
import {
  PLACEHOLDER_CREDENTIALS_MESSAGE,
  appCredentials,
  requireAppCredentials,
} from "../src/app-credentials";
import { TelegramConnectorError } from "../src/api";

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
