import { beforeEach, expect, test } from "bun:test";
import { createRealApi } from "../src/client";
import { FIXTURE_CREDENTIALS } from "../src/fixture";
import { TEST_DC_VARIABLE, testDataCenter } from "../src/test-dc";
import { TelegramConnectorError } from "../src/api";
import type { AppCredentials, DataCenter, TelegramApi } from "../src/api";
import { TelegramConnector } from "../src/connector";
import { ScriptedTelegramApi } from "../src/scripted";
import { fixtureAccount } from "../src/fixture";
import { OFFLINE, pages, reset } from "./fake-telegram";
import { CapturingWriter, ScriptedIo, rejection } from "./helpers";

beforeEach(reset);

const DC2: DataCenter = { id: 2, address: "149.154.167.40", port: 80 };

test("the test data center is off unless the variable names one", () => {
  expect(testDataCenter({})).toBeNull();
  expect(testDataCenter({ [TEST_DC_VARIABLE]: "" })).toBeNull();
  expect(testDataCenter({ [TEST_DC_VARIABLE]: "1" })).toEqual({ id: 1, address: "149.154.175.10", port: 80 });
  expect(testDataCenter({ [TEST_DC_VARIABLE]: "2" })).toEqual(DC2);
  expect(testDataCenter({ [TEST_DC_VARIABLE]: "3" })).toEqual({ id: 3, address: "149.154.175.117", port: 80 });
});

test("a value that names no test data center is refused, not ignored", () => {
  for (const value of ["0", "4", " 2", "2 ", "prod", "true", "toString", "__proto__"]) {
    let thrown: unknown = null;
    try {
      testDataCenter({ [TEST_DC_VARIABLE]: value });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TelegramConnectorError);
    expect((thrown as TelegramConnectorError).code).toBe("invalid_test_dc");
    expect((thrown as TelegramConnectorError).message).toBe(`kizuki.telegram: ${TEST_DC_VARIABLE} must be 1, 2 or 3 when set`);
  }
});

function signInWith(dataCenter: () => DataCenter | null) {
  const api = new ScriptedTelegramApi(fixtureAccount());
  const built: { session: string; credentials: AppCredentials; dataCenter: DataCenter | undefined }[] = [];
  const connector = new TelegramConnector({}, {
    api: (session, credentials, dataCenter): TelegramApi => {
      built.push({ session, credentials, dataCenter });
      return api;
    },
    credentials: () => FIXTURE_CREDENTIALS,
    sleep: async () => {},
    dataCenter,
  });
  return { connector, api, built };
}

test("a fresh sign-in is pointed at the test data center only when one is chosen", async () => {
  const chosen = signInWith(() => DC2);
  await chosen.connector.signIn(new ScriptedIo(["+9996621234", "22222"]), new CapturingWriter());
  expect(chosen.built).toEqual([{ session: "", credentials: FIXTURE_CREDENTIALS, dataCenter: DC2 }]);

  const production = signInWith(() => null);
  await production.connector.signIn(new ScriptedIo(["+15551234567", "22222"]), new CapturingWriter());
  expect(production.built).toEqual([{ session: "", credentials: FIXTURE_CREDENTIALS, dataCenter: undefined }]);
});

test("a malformed override refuses sign-in before the owner is asked anything", async () => {
  const refused = signInWith(() => testDataCenter({ [TEST_DC_VARIABLE]: "9" }));
  const io = new ScriptedIo(["+15551234567", "22222"]);
  const writer = new CapturingWriter();
  const error = await rejection(() => refused.connector.signIn(io, writer));
  expect(error.code).toBe("invalid_test_dc");
  expect(io.prompts).toEqual([]);
  expect(refused.built).toEqual([]);
  expect(refused.api.calls).toEqual([]);
  expect(writer.writes).toEqual([]);
});

test.skipIf(!OFFLINE)("the client points a fresh session at the chosen data center before dialling", async () => {
  await createRealApi("", FIXTURE_CREDENTIALS, DC2).connect();
  expect(pages.pointed).toEqual([[2, "149.154.167.40", 80]]);
  expect(pages.invoked).toEqual(["connect"]);
});

test.skipIf(!OFFLINE)("a stored session keeps its own data center whatever is chosen", async () => {
  await createRealApi("stored-session", FIXTURE_CREDENTIALS, DC2).connect();
  await createRealApi("", FIXTURE_CREDENTIALS).connect();
  expect(pages.pointed).toEqual([]);
});
