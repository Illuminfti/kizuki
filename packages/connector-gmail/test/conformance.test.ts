import { expect, test } from "bun:test";
import { runConformance } from "../../connectors/src/conformance";
import { createGmailConnector } from "../src/index";
import { GmailFixture } from "../src/testing";
test("Gmail passes the unchanged native connector conformance battery", async () => {
    const fixture = new GmailFixture(2), connector = await fixture.connected();
    const report = await runConformance(connector, { unavailable: { connector: createGmailConnector({}) }, tombstone: { prepare: async () => (await connector.backfill(null)).cursor, mutate: async () => { fixture.change("m1", "messagesDeleted"); } } });
    expect(report).toEqual({ pass: true, failures: [] });
});
