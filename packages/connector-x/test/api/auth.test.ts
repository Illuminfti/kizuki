import { expect, test } from "bun:test";
import { createXApiConnector } from "../../src/api/connector";
import { XApiFixture } from "../../src/api/testkit";
import { X_API_SCOPES, encodeState, parseState } from "../../src/api/state";

function expire(f: XApiFixture) { f.time = new Date("2027-02-01T00:00:00Z"); }
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; }

test("explicit native transport runs real PKCE and persists app/account/scopes through the host writer", async () => {
  const f = new XApiFixture(); f.authorize = true;
  const port = createXApiConnector(f.config(), f.deps()); let saved: Uint8Array | undefined;
  expect(await port.signIn(f.io, { write: async bytes => { saved = bytes.slice(); } }, { mode: "new" })).toEqual({ display: "X account" });
  const url = f.authorizations[0]!, form = f.forms[0]!.form;
  expect(url.origin).toBe("https://x.com"); expect(url.pathname).toBe("/i/oauth2/authorize");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("scope")!.split(" ")).toEqual([...X_API_SCOPES]);
  expect(form.grant_type).toBe("authorization_code"); expect(form.code_verifier!.length).toBeGreaterThan(40);
  expect(form).not.toHaveProperty("client_secret"); expect(f.listenerClosed).toBe(true);
  expect(parseState(saved!).oauth.account.id).toBe(f.account);
  expect(parseState(saved!).oauth.tokens.refresh_token).toBe(f.refresh);
  expect((await port.backfill(null)).status).toBe("unavailable");
  await port.connect(async () => new TextDecoder().decode(saved));
  expect((await port.backfill(null)).events.length).toBeGreaterThan(0);
  expect(JSON.stringify([port.manifest(), await port.health(), f.notices, f.authorizations.map(String)])).not.toContain("SYNTHETIC_X_REFRESH_CANARY");
  await port.close();
});

test("missing native callback, state mismatch, scope loss and wrong account never save enrollment", async () => {
  for (const fault of ["native", "state", "scope", "account"] as const) {
    const f = new XApiFixture(); f.authorize = true; f.wrongState = fault === "state"; let writes = 0;
    if (fault === "scope") f.beforeToken = async () => ({ status: 200, body: { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, scope: "tweet.read", token_type: "Bearer" } });
    if (fault === "account") f.before = async () => Response.json({ data: { id: "8" } });
    const deps = f.deps(); if (fault === "native") delete deps.oauth;
    const port = createXApiConnector(f.config(), deps);
    await expect(port.signIn(f.io, { write: async () => { writes++; } }, { mode: "new" })).rejects.toThrow();
    expect(writes).toBe(0);
    if (fault === "native") { expect(f.authorizations).toEqual([]); expect(f.forms).toEqual([]); expect(f.requests).toEqual([]); }
    if (fault === "state") { expect(f.forms).toEqual([]); expect(f.requests).toEqual([]); }
    await port.close();
  }
});

test("rotated tokens are durable before the first protected GET and a failed write fences the session", async () => {
  for (const reject of [false, true]) {
    const f = new XApiFixture(1), blocked = deferred<void>(), entered = deferred<void>(); let gate = false;
    const port = await f.connected({ persist: async bytes => {
      if (gate) { entered.resolve(); await blocked.promise; if (reject) throw Error("SYNTHETIC_PERSIST_CANARY"); }
      await f.persist(bytes);
    } });
    gate = true; expire(f); f.requests = [];
    const running = port.backfill(null); await entered.promise;
    expect(f.requests).toEqual([]); expect(f.forms).toHaveLength(1);
    await expect(port.sync(null)).rejects.toThrow();
    blocked.resolve(); const result = await running;
    if (reject) { expect(result.status).toBe("unavailable"); expect(f.requests).toEqual([]); expect((await port.sync(null)).status).toBe("unavailable"); }
    else { expect(result.events).toHaveLength(1); expect(parseState(f.state).oauth.tokens.refresh_token).toBe(f.refresh); expect(f.requests[0]!.headers.get("authorization")).toBe(`Bearer ${f.access}`); }
    await port.close();
  }
});

test("a local token admission deadline preserves the original refresh token for the same session", async () => {
  const f = new XApiFixture(1); let readings: number[] = [], index = 0;
  const port = await f.connected({ clock: () => readings.length === 0 ? 0 : readings[Math.min(index++, readings.length - 1)]! });
  expire(f); f.requests = []; const before = f.state.slice();
  readings = [0, 44_999, 45_000];
  expect(await port.sync(null)).toMatchObject({ events: [], cursor: null, status: "unavailable", detail: expect.stringContaining("timeout") });
  expect(f.forms).toEqual([]); expect(f.requests).toEqual([]); expect(f.state).toEqual(before);
  readings = []; expect((await port.sync(null)).events).toHaveLength(1);
  expect(f.forms).toHaveLength(1); expect(f.forms[0]!.form.refresh_token).toBe("SYNTHETIC_X_REFRESH_CANARY_0");
  expect(parseState(f.state).oauth.tokens.refresh_token).toBe("SYNTHETIC_X_REFRESH_CANARY_1");
  await port.close();
});

test("provider-crossed timeout fences later work while the original rotation still persists", async () => {
  const f = new XApiFixture(1), blocked = deferred<void>(), entered = deferred<void>(); let short = false;
  let reads = 0;
  const port = await f.connected({ clock: () => short ? (++reads === 1 ? 0 : 44_999) : 0 });
  f.beforeToken = async () => { entered.resolve(); await blocked.promise; };
  expire(f); f.requests = []; short = true;
  const running = port.sync(null); await entered.promise;
  expect((await running).detail).toContain("timeout");
  await expect(port.connect(async () => new TextDecoder().decode(f.state))).rejects.toThrow();
  blocked.resolve(); await Bun.sleep(10); short = false;
  expect(parseState(f.state).oauth.tokens.refresh_token).toBe("SYNTHETIC_X_REFRESH_CANARY_1");
  expect((await port.sync(null)).status).toBe("unavailable"); expect(f.requests).toEqual([]);
  await port.connect(async () => new TextDecoder().decode(f.state));
  expect((await port.sync(null)).events).toHaveLength(1); await port.close();
});

test("one refresh follows 401; a second 401 and explicit revoke do not silently retry", async () => {
  const f = new XApiFixture(1), port = await f.connected(); f.requests = [];
  f.failStatus = 401;
  const result = await port.sync(null);
  expect(result.detail).toContain("unauthenticated"); expect(f.forms).toHaveLength(1); expect(f.requests).toHaveLength(2);
  expect((await port.sync(null)).status).toBe("unavailable"); expect(f.forms).toHaveLength(1);
  f.failStatus = 0; await port.connect(async () => new TextDecoder().decode(f.state));
  await port.revokeProviderAccess(); expect(f.forms.at(-1)!.url).toBe("https://api.x.com/2/oauth2/revoke");
  expect((await port.health()).state).toBe("disabled"); await expect(port.sync(null)).rejects.toThrow();
});

test("saved token strings and malformed state refuse before network without secret prose", async () => {
  const f = new XApiFixture(1), raw = parseState(f.state); raw.oauth.tokens.refresh_token = "bad\nsecret";
  expect(() => encodeState(raw)).toThrow("invalid_state");
  const port = createXApiConnector(f.config(), f.deps());
  await expect(port.connect(async () => "SYNTHETIC_INVALID_STATE_CANARY")).rejects.toThrow("invalid_state");
  expect(f.requests).toEqual([]); expect(f.forms).toEqual([]);
});
