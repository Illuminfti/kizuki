import { expect, test } from "bun:test";
import { Budget, GMAIL_API, MAX_RESPONSE_BYTES, getJson } from "../src/api";
import { GmailFixture } from "../src/testing";
test("fixed endpoint, redirect and JSON byte bounds are enforced before trusted output", async () => {
    let calls = 0;
    await expect(getJson(new URL("https://other.example.test/"), "synthetic", new Budget(), async () => { calls++; return Response.json({}); })).rejects.toMatchObject({ code: "misconfigured" });
    expect(calls).toBe(0);
    await expect(getJson(new URL(`${GMAIL_API}profile`), "synthetic", new Budget(), async (request) => {
        expect(request.redirect).toBe("error");
        expect(request.method).toBe("GET");
        expect(request.body).toBeNull();
        return new Response("SECRET_SENTINEL", { status: 302, headers: { location: "https://other.example.test" } });
    })).rejects.toMatchObject({ status: 302 });
    await expect(getJson(new URL(`${GMAIL_API}profile`), "synthetic", new Budget(), async () => new Response('"' + "x".repeat(MAX_RESPONSE_BYTES) + '"'))).rejects.toMatchObject({ code: "source_schema" });
});
test("request-count bound never opens the twenty-sixth request", async () => {
    const budget = new Budget();
    let calls = 0;
    const transport = async () => { calls++; return Response.json({}); };
    for (let i = 0; i < 25; i++)
        await getJson(new URL(`${GMAIL_API}profile`), "synthetic", budget, transport);
    await expect(getJson(new URL(`${GMAIL_API}profile`), "synthetic", budget, transport)).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toBe(25);
});
test("oversized history page refuses without persisting a partial change list", async () => {
    const fixture = new GmailFixture(1), connector = await fixture.connected();
    const before = await connector.backfill(null), saved = fixture.state.slice();
    const original = fixture.fetch;
    // The public dependency was snapshotted; substitute provider response through its existing hook.
    const { createGmailConnector } = await import("../src/index");
    const { FIELDS } = await import("../src/state");
    const giant = createGmailConnector({ client: { id: "synthetic" }, secret_ref: "file:synthetic", fields: FIELDS }, { persist: fixture.persist, now: fixture.now, fetch: async (request) => request.url.includes("/history?") ? Response.json({ historyId: "101", history: [{ id: "101", messagesDeleted: Array.from({ length: 1001 }, (_, i) => ({ message: { id: `m${i}` } })) }] }) : original(request) });
    await giant.connect(async () => new TextDecoder().decode(fixture.state));
    const result = await giant.sync(before.cursor);
    expect(result.status).toBe("unavailable");
    expect(result.cursor).toBe(before.cursor);
    expect(result.events).toEqual([]);
    expect(fixture.state).toEqual(saved);
});
test("an unresponsive HTTP transport is bounded and late completion is discarded", async () => {
    let signal: AbortSignal | undefined, release!: (response: Response) => void;
    const started = Date.now();
    const work = getJson(new URL(`${GMAIL_API}profile`), "synthetic", new Budget(), async (request) => { signal = request.signal; return new Promise<Response>(resolve => { release = resolve; }); });
    await expect(work).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(6500);
    expect(signal!.aborted).toBe(true);
    release(Response.json({ historyId: "100" }));
}, 7000);
