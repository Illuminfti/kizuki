import { expect, test } from "bun:test";
import * as production from "../src";
import * as testkit from "../src/testkit";

test("production entrypoint does not export fixture mutation helpers", () => {
  expect("seedFixtureDatabase" in production).toBe(false);
  expect("FIXTURE_NOW" in production).toBe(false);
  expect("FIXTURE_DDL" in production).toBe(false);
  expect("FIXTURE_MIGRATIONS" in production).toBe(false);
});

test("testkit subpath exports the fixture helpers", () => {
  expect(typeof testkit.seedFixtureDatabase).toBe("function");
  expect(typeof testkit.FIXTURE_NOW).toBe("string");
  expect(typeof testkit.FIXTURE_DDL).toBe("string");
  expect(Array.isArray(testkit.FIXTURE_MIGRATIONS)).toBe(true);
});
