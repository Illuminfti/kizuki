import { expect, test } from "bun:test";
import type { OAuthTransport } from "@kizuki/core";
import { createGmailConnector, GMAIL_SCOPES } from "../src/index";
import { GmailFixture } from "../src/testing";
import { FIELDS, parseState } from "../src/state";
const config = { client: { id: "synthetic-desktop-client" }, secret_ref: "file:synthetic", fields: FIELDS };
const OLD_ACCESS = "synthetic-access-not-a-credential", OLD_REFRESH = "synthetic-refresh-not-a-credential";
const NEW_ACCESS = "synthetic-rotated-access-not-a-credential", NEW_REFRESH = "synthetic-rotated-refresh-not-a-credential";
const TOKENS = [OLD_ACCESS, OLD_REFRESH, NEW_ACCESS, NEW_REFRESH];
interface Seen { url: string; bearer: string | null; persistedAccess: string; }
/** Gmail GETs observed with the bearer they carried and the durable token at that instant. */
function harness(fixture: GmailFixture, answer: { status: number; body: unknown }) {
    const posts: Record<string, string>[] = [], gets: Seen[] = [];
    let reject = (_seen: Seen) => false;
    const oauth: OAuthTransport = { listen: async () => { throw new Error("not used"); }, postForm: async (_url, form) => { posts.push(form); return answer; } };
    const fetch = async (request: Request): Promise<Response> => {
        const seen: Seen = { url: request.url, bearer: request.headers.get("authorization"), persistedAccess: parseState(fixture.state).oauth.tokens.access_token };
        if (request.url.includes("/users/me/"))
            gets.push(seen);
        if (reject(seen))
            return Response.json({ error: "SECRET_SENTINEL" }, { status: 401 });
        return fixture.fetch(request);
    };
    const connector = createGmailConnector(config, { oauth, fetch, persist: fixture.persist, now: fixture.now });
    return { connector, posts, gets, setReject: (next: (seen: Seen) => boolean) => { reject = next; } };
}
const rotated = { status: 200, body: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600, scope: GMAIL_SCOPES.join(" "), token_type: "Bearer" } };
test("a 401 costs one refresh, persists rotation before the retry, and leaks no token", async () => {
    const fixture = new GmailFixture(1), h = harness(fixture, rotated);
    h.setReject(seen => seen.url.includes("/profile") && seen.bearer === `Bearer ${OLD_ACCESS}`);
    await h.connector.connect(async () => new TextDecoder().decode(fixture.state));
    const result = await h.connector.backfill(null);
    expect(result.status).toBeUndefined();
    expect(result.events).toHaveLength(1);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: OLD_REFRESH });
    const profile = h.gets.filter(seen => seen.url.includes("/profile"));
    expect(profile.map(seen => seen.bearer)).toEqual([`Bearer ${OLD_ACCESS}`, `Bearer ${NEW_ACCESS}`]);
    expect(profile[0]!.persistedAccess).toBe(OLD_ACCESS);
    expect(profile[1]!.persistedAccess).toBe(NEW_ACCESS);
    expect(h.gets.slice(h.gets.indexOf(profile[1]!)).every(seen => seen.bearer === `Bearer ${NEW_ACCESS}`)).toBe(true);
    expect(parseState(fixture.state).oauth.tokens).toMatchObject({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH });
    const visible = JSON.stringify([result, await h.connector.health()]);
    for (const token of TOKENS)
        expect(visible).not.toContain(token);
    expect(visible).not.toContain("SECRET_SENTINEL");
});
test("a second consecutive 401 after refresh is unavailable without a third GET or second refresh", async () => {
    const fixture = new GmailFixture(1), h = harness(fixture, rotated);
    await h.connector.connect(async () => new TextDecoder().decode(fixture.state));
    const { cursor } = await h.connector.backfill(null);
    const before = h.gets.length;
    h.setReject(() => true);
    const result = await h.connector.sync(cursor);
    expect(result.status).toBe("unavailable");
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe(cursor);
    expect(result.detail).not.toContain("SECRET_SENTINEL");
    expect(h.posts).toHaveLength(1);
    const after = h.gets.slice(before);
    expect(after.map(seen => seen.bearer)).toEqual([`Bearer ${OLD_ACCESS}`, `Bearer ${NEW_ACCESS}`]);
    expect(new Set(after.map(seen => seen.url)).size).toBe(1);
    expect((await h.connector.health()).state).toBe("degraded");
});
test("invalid_grant on refresh refuses without retrying, advancing, or rewriting state", async () => {
    const fixture = new GmailFixture(1), h = harness(fixture, { status: 400, body: { error: "invalid_grant", error_description: "SECRET_SENTINEL" } });
    await h.connector.connect(async () => new TextDecoder().decode(fixture.state));
    const { cursor } = await h.connector.backfill(null);
    const persisted = fixture.state.slice(), before = h.gets.length;
    h.setReject(() => true);
    const result = await h.connector.sync(cursor);
    expect(result.status).toBe("unavailable");
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe(cursor);
    expect(result.detail).toContain("unauthenticated");
    expect(result.detail).not.toContain("SECRET_SENTINEL");
    expect(h.posts).toHaveLength(1);
    expect(h.gets.slice(before)).toHaveLength(1);
    expect(fixture.state).toEqual(persisted);
    expect(parseState(fixture.state).oauth.tokens.refresh_token).toBe(OLD_REFRESH);
    // The rejected grant fences this instance: the host must reconnect from durable state.
    await expect(h.connector.sync(cursor)).rejects.toMatchObject({ code: "unavailable" });
    expect(h.gets.slice(before)).toHaveLength(1);
    expect((await h.connector.health()).state).toBe("degraded");
});
