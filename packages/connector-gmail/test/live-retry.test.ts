import { expect, test } from "bun:test";
import { GmailFixture } from "../src/testing";
import { MAX_CURSOR_BYTES, MAX_CONNECTION_STATE_BYTES } from "@kizuki/core";
for (const change of ["version", "content", "missing"] as const) {
    test(`lost live batch refuses a changed ${change} after reconnect`, async () => {
        const fixture = new GmailFixture(2);
        const connector = await fixture.connected();
        const original = await connector.backfill(null);
        expect(original.events).toHaveLength(2);
        // The response can have been lost before the host wrote its checkpoint.
        if (change === "version")
            fixture.messages.get("m1")!.historyId = "101";
        else if (change === "missing")
            fixture.missing.add("m1");
        else
            fixture.messages.get("m1")!.payload = { mimeType: "text/plain", body: { data: Buffer.from("Changed synthetic body").toString("base64url") } };
        fixture.advanceDay();
        const reopened = await fixture.connected();
        const retried = await reopened.backfill(null);
        expect(retried.status).toBe("unavailable");
        expect(retried.events).toEqual([]);
        expect(retried.cursor).toBeNull();
        expect(retried.detail).toContain("snapshot_gap_unresolved");
        expect(JSON.stringify(retried)).not.toContain("Changed synthetic body");
        expect(fixture.state.byteLength).toBeLessThan(MAX_CONNECTION_STATE_BYTES);
        expect(Buffer.byteLength(original.cursor!)).toBeLessThanOrEqual(MAX_CURSOR_BYTES);
        expect(new TextDecoder().decode(fixture.state)).not.toContain("Synthetic message body");
    });
}
test("uncertain witness persistence fences the instance and reconnect reuses the durable witness", async () => {
    const fixture = new GmailFixture(1);
    let wroteWitness = false;
    const connector = await fixture.connected(async (bytes) => {
        await fixture.persist(bytes);
        const pending = JSON.parse(new TextDecoder().decode(bytes)).pending;
        if (pending?.fence) {
            wroteWitness = true;
            throw Error("synthetic lost witness response");
        }
    });
    const lost = await connector.backfill(null);
    expect(wroteWitness).toBe(true);
    expect(lost.status).toBe("unavailable");
    expect(lost.events).toEqual([]);
    await expect(connector.backfill(null)).rejects.toMatchObject({ code: "unavailable" });
    fixture.messages.get("m1")!.historyId = "102";
    const reopened = await fixture.connected();
    expect((await reopened.backfill(null)).detail).toContain("snapshot_gap_unresolved");
});
test("later history-batch witness keeps its original immutable cursor identity on retry", async () => {
    const fixture = new GmailFixture(25);
    const connector = await fixture.connected();
    let base = await connector.backfill(null);
    base = await connector.backfill(base.cursor);
    // One provider history entry can contain many message changes.
    for (let n = 1; n <= 25; n++)
        fixture.messages.get(`m${n}`)!.historyId = "101";
    const { createGmailConnector } = await import("../src/index");
    const { FIELDS } = await import("../src/state");
    const configured = createGmailConnector({ client: { id: "synthetic" }, fields: FIELDS, secret_ref: "file:synthetic" }, {
        persist: fixture.persist, now: fixture.now,
        fetch: async (request) => request.url.includes("/history?") ? Response.json({ historyId: "101", history: [{ id: "101", messagesAdded: Array.from({ length: 25 }, (_, i) => ({ message: { id: `m${i + 1}` } })) }] }) : fixture.fetch(request),
    });
    await configured.connect(async () => new TextDecoder().decode(fixture.state));
    const first = await configured.sync(base.cursor);
    expect(first.events).toHaveLength(20);
    const second = await configured.sync(first.cursor);
    expect(second.events).toHaveLength(5);
    expect((await configured.sync(first.cursor)).events).toEqual(second.events);
    const requestsBeforeStale = fixture.requests.length;
    expect((await configured.sync(base.cursor)).detail).toContain("snapshot_gap_unresolved");
    expect(fixture.requests).toHaveLength(requestsBeforeStale);
    fixture.messages.get("m21")!.historyId = "102";
    const changed = await configured.sync(first.cursor);
    expect(changed.status).toBe("unavailable");
    expect(changed.cursor).toBe(first.cursor);
    expect(changed.events).toEqual([]);
    expect(changed.detail).toContain("snapshot_gap_unresolved");
});
test("fence refuses stale or skipped offsets without acquiring another provider message", async () => {
    const fixture = new GmailFixture(45), connector = await fixture.connected();
    const first = await connector.backfill(null);
    const pending = JSON.parse(new TextDecoder().decode(fixture.state)).pending;
    const { planIdentity } = await import("../src/state");
    const forged = JSON.stringify({ ...pending.base, plan: planIdentity(pending), offset: 1 });
    const requests = fixture.requests.length;
    const refused = await connector.backfill(forged);
    expect(refused.detail).toContain("snapshot_gap_unresolved");
    expect(refused.cursor).toBe(forged);
    expect(fixture.requests).toHaveLength(requests);
    // After receiving the next legitimate cursor the earlier batch witness is obsolete.
    const second = await connector.backfill(first.cursor);
    expect(second.events).toHaveLength(20);
    // A different plan is a different page; replay its current witness, not a fabricated earlier offset.
    const current = JSON.parse(new TextDecoder().decode(fixture.state)).pending;
    const skipped = JSON.stringify({ ...current.base, plan: planIdentity(current), offset: 1 });
    expect((await connector.backfill(skipped)).detail).toContain("snapshot_gap_unresolved");
});
test("an old pending plan without a replay witness refuses instead of adopting unproved history", async () => {
    const fixture = new GmailFixture(1), connector = await fixture.connected();
    await connector.backfill(null);
    const envelope = JSON.parse(new TextDecoder().decode(fixture.state));
    delete envelope.pending.fence;
    fixture.state = new TextEncoder().encode(JSON.stringify(envelope));
    const before = fixture.state.slice(), requests = fixture.requests.length;
    await expect(fixture.connected()).rejects.toMatchObject({ code: "source_schema" });
    expect(fixture.state).toEqual(before);
    expect(fixture.requests).toHaveLength(requests);
});
