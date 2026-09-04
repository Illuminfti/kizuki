import { afterEach, expect, test } from "bun:test";
import { runConformance } from "../../connectors/src/testkit";
import { ScreenpipeConnector } from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

test("kizuki.screenpipe passes the shared conformance suite", async () => {
  const fixture = createFixtureDatabase();
  const connector = new ScreenpipeConnector(
    { path: fixture.path, settle_seconds: 0 },
    fixtureDeps("2026-01-09T00:00:00.000Z"),
  );

  expect(await runConformance(connector)).toEqual({
    pass: true,
    failures: [],
  });
  await connector.revoke();
});
