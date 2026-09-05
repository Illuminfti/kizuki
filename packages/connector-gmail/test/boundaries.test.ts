import { expect, test } from "bun:test";
import { KizukiError, validateEventInput, type OAuthTransport } from "@kizuki/core";
import { createGmailConnector, GMAIL_SCOPES } from "../src/index";
import { GmailFixture } from "../src/testing";
import { FIELDS, parseState, encodeState } from "../src/state";
const config = { client: { id: "synthetic-desktop-client" }, secret_ref: "file:synthetic", fields: FIELDS };
test("untrusted typed transport and resolver errors are redacted", async () => {
    const fixture = new GmailFixture(1);
    const connector = createGmailConnector(config, { persist: fixture.persist, fetch: async () => { throw new KizukiError("unavailable", "SECRET_SENTINEL"); } });
    await expect(connector.connect(async () => new TextDecoder().decode(fixture.state))).rejects.not.toThrow("SECRET_SENTINEL");
    const resolver = createGmailConnector(config, { persist: fixture.persist, fetch: fixture.fetch });
    await expect(resolver.connect(async () => { throw new KizukiError("missing_secret", "SECRET_SENTINEL"); })).rejects.not.toThrow("SECRET_SENTINEL");
});
test("missing meaningful date refuses the complete batch and keeps checkpoint", async () => {
    const fixture = new GmailFixture(2);
    delete fixture.messages.get("m2")!.internalDate;
    const connector = await fixture.connected();
    const result = await connector.backfill(null);
    expect(result.status).toBe("unavailable");
    expect(result.events).toEqual([]);
    expect(result.cursor).toBeNull();
});
test("explicit fields suppress persisted body and provider body-data projection", async () => {
    const fixture = new GmailFixture(1), state = parseState(fixture.state);
    state.fields = ["labels"];
    fixture.state = encodeState(state);
    const connector = createGmailConnector({ ...config, fields: ["labels"] }, { fetch: fixture.fetch, persist: fixture.persist, now: fixture.now });
    await connector.connect(async () => new TextDecoder().decode(fixture.state));
    const result = await connector.backfill(null), event = result.events[0]!;
    expect(event.text).toBe("");
    expect(event.subjects).toEqual([]);
    expect(event.attachments).toEqual([]);
    expect(event.metadata.headers).toBeUndefined();
    const request = new URL(fixture.requests.find(url => url.includes("/messages/m1"))!);
    expect(request.searchParams.get("format")).toBe("metadata");
    expect(request.searchParams.get("fields")).not.toContain("data");
    expect(validateEventInput(event).ok).toBe(true);
});
test("backfill stops at 1000 records and reports partial instead of false complete", async () => {
    const fixture = new GmailFixture(1001), connector = await fixture.connected();
    let cursor: string | null = null, stored = 0, detail = "";
    for (let batch = 0; batch < 51; batch++) {
        const result = await connector.backfill(cursor);
        expect(result.status).not.toBe("unavailable");
        stored += result.events.length;
        cursor = result.cursor;
        detail = result.detail ?? "";
        if (result.events.length === 0)
            break;
    }
    expect(stored).toBe(1000);
    expect(detail).toContain("backfill_cap_partial");
    expect(fixture.requests.filter(url => url.includes("/messages/m1001?")).length).toBe(0);
});
test("multiple history pages do not advance anchor before their last page", async () => {
    const fixture = new GmailFixture(25), connector = await fixture.connected();
    let base = await connector.backfill(null);
    base = await connector.backfill(base.cursor);
    for (let i = 1; i <= 25; i++)
        fixture.change(`m${i}`, "messagesDeleted");
    const first = await connector.sync(base.cursor);
    expect(first.events).toHaveLength(20);
    expect(JSON.parse(first.cursor!).anchor).toBe("100");
    const second = await connector.sync(first.cursor);
    expect(second.events).toHaveLength(5);
    expect(JSON.parse(second.cursor!).anchor).toBe("125");
    expect(new Set([...first.events, ...second.events].map(e => e.source_record_id)).size).toBe(25);
});
test("a late response after local revoke cannot yield content or persist a plan", async () => {
    const fixture = new GmailFixture(1), connector = await fixture.connected();
    let release!: () => void, arrived!: () => void;
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    fixture.beforeRequest = async (request) => { if (request.url.includes("/messages?")) {
        arrived();
        await new Promise<void>(resolve => { release = resolve; });
    } };
    const before = fixture.state.slice(), pending = connector.backfill(null);
    await ready;
    await connector.revoke();
    release();
    const result = await pending;
    expect(result.status).toBe("unavailable");
    expect(result.events).toEqual([]);
    expect(fixture.state).toEqual(before);
});
test("rotated OAuth tokens persist before use and cannot be silently memory-only", async () => {
    const fixture = new GmailFixture(1), state = parseState(fixture.state);
    state.oauth.tokens.expires_at = "2020-01-01T00:00:00.000Z";
    fixture.state = encodeState(state);
    let writes = 0, posts = 0;
    const oauth: OAuthTransport = { listen: async () => { throw new Error("not used"); }, postForm: async () => { posts++; return { status: 200, body: { access_token: "synthetic-rotated-access", refresh_token: "synthetic-rotated-refresh", expires_in: 3600, scope: GMAIL_SCOPES.join(" "), token_type: "Bearer" } }; } };
    const connector = createGmailConnector(config, { oauth, now: fixture.now, persist: async (bytes) => { writes++; await fixture.persist(bytes); }, fetch: async (request) => { expect(writes).toBe(1); expect(request.headers.get("authorization")).toBe("Bearer synthetic-rotated-access"); return fixture.fetch(request); } });
    await connector.connect(async () => new TextDecoder().decode(fixture.state));
    expect(posts).toBe(1);
    expect(parseState(fixture.state).oauth.tokens.refresh_token).toBe("synthetic-rotated-refresh");
});
test("missing-message coverage survives subsequent successful empty sync", async () => {
    const fixture = new GmailFixture(1), connector = await fixture.connected();
    const base = await connector.backfill(null);
    fixture.change("m1", "labelsAdded");
    fixture.missing.add("m1");
    const missing = await connector.sync(base.cursor);
    expect(missing.detail).toContain("message_unavailable");
    const later = await connector.sync(missing.cursor);
    expect(later.detail).toContain("message_unavailable");
});
test("recognized quota reason is rate-limited without echoing provider diagnostics", async () => {
    const fixture = new GmailFixture(1);
    const connector = createGmailConnector(config, { persist: fixture.persist, now: fixture.now, fetch: async (request) => request.url.includes("/history?") ? Response.json({ error: { message: "SECRET_SENTINEL", errors: [{ reason: "userRateLimitExceeded" }] } }, { status: 403 }) : fixture.fetch(request) });
    await connector.connect(async () => new TextDecoder().decode(fixture.state));
    const base = await connector.backfill(null);
    const result = await connector.sync(base.cursor);
    expect(result.status).toBe("unavailable");
    expect(result.detail).toContain("rate_limited");
    expect(result.detail).not.toContain("SECRET_SENTINEL");
});
test("live provider version identity stays a decimal string beyond JS integer precision", async () => {
    const fixture = new GmailFixture(1);
    fixture.messages.get("m1")!.historyId = "900719925474099312345";
    const connector = await fixture.connected(), result = await connector.backfill(null);
    expect(result.events[0]!.metadata.history_id).toBe("900719925474099312345");
});
