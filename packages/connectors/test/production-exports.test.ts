import { expect, test } from "bun:test";
import * as production from "../src";
import * as testkit from "../src/testkit";

test("production entrypoint does not export conformance or fixture helpers", () => {
  expect("runConformance" in production).toBe(false);
  expect("InMemoryLedger" in production).toBe(false);
  expect("seedFixtureDatabase" in production).toBe(false);
  expect("CHATGPT_FIXTURE_EXPORT" in production).toBe(false);
  expect("CLAUDE_FIXTURE_EXPORT" in production).toBe(false);
  expect("FIXTURE_NOW" in production).toBe(false);
});

test("testkit subpath exports the helpers tests need", () => {
  expect(typeof testkit.runConformance).toBe("function");
  expect(typeof testkit.InMemoryLedger).toBe("function");
  expect(typeof testkit.seedFixtureDatabase).toBe("function");
  expect(Array.isArray(testkit.CHATGPT_FIXTURE_EXPORT)).toBe(true);
  expect(Array.isArray(testkit.CLAUDE_FIXTURE_EXPORT)).toBe(true);
  expect(typeof testkit.hangingConnector).toBe("function");
  expect(typeof testkit.dishonestPurgeConnector).toBe("function");
});

test("production entrypoint does not export conformance fixtures", () => {
  expect("hangingConnector" in production).toBe(false);
  expect("dishonestPurgeConnector" in production).toBe(false);
  expect("mutableManifestConnector" in production).toBe(false);
});
