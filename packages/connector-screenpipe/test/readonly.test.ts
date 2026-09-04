import { afterEach, describe, expect, test } from "bun:test";
import { ScreenpipeConnector } from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

async function sha256(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

describe("screenpipe read-only behavior", () => {
  test("backfill, sync, health and purgeSource leave the file byte-identical", async () => {
    const fixture = createFixtureDatabase();
    fixture.writer.close();
    const before = await sha256(fixture.path);
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    await connector.health();
    const first = await connector.backfill(null);
    await connector.sync(first.cursor);
    await expect(
      connector.purgeSource("screenpipe:site:mail.acme.example"),
    ).rejects.toMatchObject({ code: "not_supported" });
    await connector.revoke();

    expect(await sha256(fixture.path)).toBe(before);
  });

  test("the connector holds no lock a writer notices", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const first = await connector.backfill(null);

    expect(() =>
      insertFrame(fixture.writer, {
        id: 9,
        timestamp: "2026-01-08T00:00:00Z",
        fullText: "concurrent append",
      }),
    ).not.toThrow();
    expect(
      (await connector.sync(first.cursor)).events.map(
        ({ source_record_id }) => source_record_id,
      ),
    ).toEqual(["frame:9"]);
    await connector.revoke();
  });
});
