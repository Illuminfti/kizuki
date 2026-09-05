import { expect, test } from "bun:test";
import type { OAuthTransport, SignInIo } from "@kizuki/core";
import { createGmailConnector, GMAIL_SCOPES } from "../src/index";
import { FIELDS, parseState } from "../src/state";
function oauthFixture(scope = GMAIL_SCOPES.join(" "), cancel = false) {
    let callback!: (url: URL) => void, posts = 0, writes = 0, gets = 0;
    const result = new Promise<URL>(resolve => { callback = resolve; });
    const transport: OAuthTransport = { listen: async () => ({ redirect_uri: "http://127.0.0.1:39271/callback", callback: () => result, close: async () => { } }), postForm: async (url, form) => {
            posts++;
            expect(url).toBe("https://oauth2.googleapis.com/token");
            expect(form.code_verifier).toBeDefined();
            return { status: 200, body: { access_token: "synthetic-access-only", refresh_token: "synthetic-refresh-only", token_type: "Bearer", expires_in: 3600, scope } };
        } };
    const io: SignInIo = { prompt: async () => { throw new Error("No key-pasting prompt"); }, notify: () => { }, openUrl: async (raw) => {
            const url = new URL(raw);
            expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
            expect(url.searchParams.get("code_challenge_method")).toBe("S256");
            expect(url.searchParams.get("scope")).toBe(GMAIL_SCOPES.join(" "));
            const reply = new URL("http://127.0.0.1:39271/callback");
            reply.searchParams.set("state", url.searchParams.get("state")!);
            reply.searchParams.set(cancel ? "error" : "code", cancel ? "access_denied" : "synthetic-code");
            callback(reply);
        } };
    let state: Uint8Array | undefined;
    const connector = createGmailConnector({ client: { id: "synthetic-desktop-client" }, fields: FIELDS }, { oauth: transport, fetch: async () => { gets++; return Response.json({ sub: "fixture-account", email: "mutable@example.test" }); }, now: () => new Date("2024-01-01T00:00:00Z") });
    return { connector, io, deps: {oauth: transport, fetch: async () => Response.json({sub:"fixture-account"}), now: () => new Date("2024-01-01T00:00:00Z")}, writer: { write: async (bytes: Uint8Array) => { writes++; state = bytes; } }, counts: () => ({ posts, writes, gets }), state: () => state };
}
test("sanctioned PKCE sign-in writes one scoped opaque state with stable OIDC sub", async () => {
    const f = oauthFixture();
    await f.connector.signIn(f.io, f.writer);
    expect(f.counts()).toEqual({ posts: 1, writes: 1, gets: 1 });
    const state = parseState(f.state()!);
    expect(state.oauth.account.id).toBe("fixture-account");
    expect(state.oauth.account.display).not.toContain("mutable@example.test");
    expect(state.pending).toBeNull();
    expect(state.fields).toEqual([...FIELDS]);
});
test("enrollment bounds an unresolved writer and fences another sign-in until reload", async () => {
    const f = oauthFixture();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = f.connector.signIn(f.io, { write: async bytes => {
        entered(); await new Promise<void>(resolve => { release = resolve; });
        await f.writer.write(bytes);
    } }).then(() => "success", error => error.code);
    await started;
    const result = await Promise.race([pending, Bun.sleep(6500).then(() => "still_pending")]);
    try {
        expect(result).toBe("timeout");
        await expect(f.connector.signIn(f.io, f.writer)).rejects.toMatchObject({ code: "unavailable" });
        expect(f.counts()).toEqual({ posts: 1, writes: 0, gets: 1 });
    } finally { release(); await pending; }
    await Bun.sleep(20);
    expect(f.counts().writes).toBe(1);
    expect(parseState(f.state()!).oauth.account.id).toBe("fixture-account");
    await expect(f.connector.signIn(f.io, f.writer)).rejects.toMatchObject({ code: "unavailable" });
}, 10000);
test("cancel and missing granted scope write no state; missing scope performs no Gmail read", async () => {
    const cancel = oauthFixture(undefined, true);
    await expect(cancel.connector.signIn(cancel.io, cancel.writer)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(cancel.counts()).toEqual({ posts: 0, writes: 0, gets: 0 });
    const narrow = oauthFixture("openid email");
    await expect(narrow.connector.signIn(narrow.io, narrow.writer)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(narrow.counts()).toEqual({ posts: 1, writes: 0, gets: 0 });
});

test('reauthorization retains the exact pending history witness instead of orphaning its checkpoint',async()=>{
 const {GmailFixture}=await import('../src/testing');const source=new GmailFixture(1);await (await source.connected()).backfill(null);
 const previous=parseState(source.state), f=oauthFixture();let candidate:Uint8Array|undefined;
 // Exercise the real OAuth sign-in with previous state supplied only at runtime.
 const original=f.deps;
 const connector=createGmailConnector({client:{id:'synthetic-desktop-client'},fields:FIELDS},{...original,previousState:source.state});
 await connector.signIn(f.io,{write:async bytes=>{candidate=bytes}});
 expect(parseState(candidate!).pending).toEqual(previous.pending);
});

test('public state inspection omits credentials and replacement rejects changed fields or pending history',async()=>{
 const {inspectGmailState,assertSameGmailIdentity}=await import('../src/index');
 const {encodeState}=await import('../src/state');const {GmailFixture}=await import('../src/testing');
 const f=new GmailFixture(1);await (await f.connected()).backfill(null);const original=f.state.slice();
 expect(inspectGmailState(original)).toEqual({account_id:'fixture-account',fields:[...FIELDS],has_pending:true});expect(JSON.stringify(inspectGmailState(original))).not.toContain('synthetic-access');
 const rotated=parseState(original);rotated.oauth.tokens.access_token='synthetic-rotated';expect(()=>assertSameGmailIdentity(original,encodeState(rotated))).not.toThrow();
 for(const change of ['account','fields','pending'] as const){const candidate=parseState(original);if(change==='account')candidate.oauth.account.id='other-synthetic';else if(change==='fields')candidate.fields=['text'];else candidate.pending=null;expect(()=>assertSameGmailIdentity(original,encodeState(candidate))).toThrow();}
});
