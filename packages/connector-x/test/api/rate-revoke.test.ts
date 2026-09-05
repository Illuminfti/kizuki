import { expect, test } from "bun:test";
import { XApiFixture } from "../../src/api/testkit";
import { encodeState, parseState } from "../../src/api/state";

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; }

for (const when of ["connect", "expired", "401"] as const) test(`token 429 is durable without forced reauthorization: ${when}`, async () => {
  const f = new XApiFixture(1);
  if (when === "connect") { const state = parseState(f.state); state.oauth.tokens.expires_at = "2025-01-01T00:00:00Z"; f.state = encodeState(state); }
  if (when === "connect") f.beforeToken = async () => ({ status: 429, body: { error: "SYNTHETIC_TOKEN_RATE_CANARY" } });
  const port = await f.connected(); f.requests = [];
  if (when === "expired") f.time = new Date("2027-02-01T00:00:00Z");
  if (when === "401") f.before = async request => request.headers.get("authorization") === "Bearer SYNTHETIC_X_ACCESS_CANARY_0" ? Response.json({}, { status: 401 }) : undefined;
  f.beforeToken = async () => ({ status: 429, body: { error: "SYNTHETIC_TOKEN_RATE_CANARY" } });
  const result = await port.sync(null);
  expect(result).toMatchObject({ status: "unavailable", cursor: null, events: [] }); expect(result.detail).toContain("rate_limited"); expect(result.detail).not.toContain("CANARY");
  expect(parseState(f.state).retry_at).toBe(new Date(f.time.getTime() + 60_000).toISOString());
  expect((await port.health()).state).toBe("rate_limited"); expect(f.forms).toHaveLength(1); expect(f.requests).toHaveLength(when === "401" ? 1 : 0);
  expect(parseState(f.state).oauth.tokens.refresh_token).toBe("SYNTHETIC_X_REFRESH_CANARY_0");
  const requests = f.requests.length; expect((await port.sync(null)).status).toBe("unavailable"); expect(f.requests).toHaveLength(requests); expect(f.forms).toHaveLength(1);
  delete f.beforeToken; f.time = new Date(f.time.getTime() + 61_000);
  expect((await port.sync(null)).events).toHaveLength(1); expect(f.forms).toHaveLength(2); expect(f.forms[1]!.form.refresh_token).toBe("SYNTHETIC_X_REFRESH_CANARY_0"); await port.close();
});

test("token-429 cooldown persistence failure fences the caller instead of keeping an unrecorded session", async () => {
  const f = new XApiFixture(1), port = await f.connected({ persist: async () => { throw Error("SYNTHETIC_CAS_FAILURE_CANARY"); } });
  f.time = new Date("2027-02-01T00:00:00Z"); f.requests = [];
  f.beforeToken = async () => ({ status: 429, body: {} });
  expect((await port.sync(null)).status).toBe("unavailable"); expect(parseState(f.state).retry_at).toBeNull();
  expect((await port.sync(null)).status).toBe("unavailable"); expect(f.forms).toHaveLength(1); expect(f.requests).toEqual([]); await port.close();
});

test("provider revocation fences first, revokes offline refresh then access, and restores with no egress", async () => {
  const f = new XApiFixture(1), access = f.access, refresh = f.refresh, port = await f.connected();
  f.beforeToken = async () => { expect(parseState(f.state).revocation).toBe("pending"); };
  await port.revokeProviderAccess();
  expect(f.forms.map(entry => entry.form.token)).toEqual([refresh, access]); expect([...f.revokedTokens]).toEqual([refresh, access]);
  expect(parseState(f.state).revocation).toBe("revoked"); expect((await port.health()).state).toBe("disabled");
  f.time = new Date("2027-02-01T00:00:00Z"); const gets = f.requests.length, forms = f.forms.length, restored = await f.connected();
  expect(f.requests).toHaveLength(gets); expect(f.forms).toHaveLength(forms); expect((await restored.sync(null)).status).toBe("unavailable");
  await restored.revokeProviderAccess(); expect(f.forms).toHaveLength(forms); expect(f.tokenCount).toBe(0);
});

for (const failAt of [1, 2]) test(`partial provider revoke remains fenced and explicitly retryable after restore: request ${failAt}`, async () => {
  const f = new XApiFixture(1), port = await f.connected(); let calls = 0;
  f.beforeToken = async () => ++calls === failAt ? { status: 503, body: { error: "SYNTHETIC_REVOKE_CANARY" } } : undefined;
  await expect(port.revokeProviderAccess()).rejects.toThrow(); expect(parseState(f.state).revocation).toBe("pending"); expect((await port.health()).state).toBe("disabled");
  f.time = new Date("2027-02-01T00:00:00Z"); const requests = f.requests.length, forms = f.forms.length;
  const restored = await f.connected(); expect((await restored.sync(null)).status).toBe("unavailable"); expect(f.requests).toHaveLength(requests); expect(f.forms).toHaveLength(forms);
  delete f.beforeToken; await restored.revokeProviderAccess(); expect(parseState(f.state).revocation).toBe("revoked"); expect(f.forms).toHaveLength(forms + 2); expect(f.tokenCount).toBe(0);
});

test("GET retry hints persist at the local automatic ceiling instead of centuries", async () => {
  const f = new XApiFixture(1), port = await f.connected(); f.failStatus = 429; f.retryAfter = "9999999999";
  expect((await port.sync(null)).detail).toContain("rate_limited"); expect(parseState(f.state).retry_at).toBe("2026-02-02T00:00:00.000Z"); await port.close();
});

test("a late token-429 write preserves cooldown through original custody without reviving its caller", async () => {
  const f = new XApiFixture(1), entered = deferred<void>(), blocked = deferred<void>(); let short = false, ticks = 0;
  const port = await f.connected({ clock: () => short ? (++ticks === 1 ? 0 : 44_999) : 0, persist: async bytes => {
    entered.resolve(); await blocked.promise; await f.persist(bytes);
  } });
  f.beforeToken = async () => ({ status: 429, body: {} }); f.time = new Date("2027-02-01T00:00:00Z"); f.requests = []; short = true;
  const running = port.sync(null); await entered.promise; expect((await running).detail).toContain("timeout");
  await expect(port.connect(async () => new TextDecoder().decode(f.state))).rejects.toThrow(); blocked.resolve(); await Bun.sleep(10);
  expect(parseState(f.state).retry_at).toBe("2027-02-01T00:01:00.000Z"); expect((await port.sync(null)).status).toBe("unavailable");
  const restored = await f.connected(); expect(f.requests).toEqual([]); expect((await restored.health()).state).toBe("rate_limited");
  f.time = new Date("2027-02-01T00:01:01Z"); delete f.beforeToken;
  expect((await restored.sync(null)).events).toHaveLength(1); expect(f.forms.at(-1)!.form.refresh_token).toBe("SYNTHETIC_X_REFRESH_CANARY_0"); await restored.close();
});

test("a late pending-revoke write permits explicit retry after restore and never starts remote work early", async () => {
  const f = new XApiFixture(1), entered = deferred<void>(), blocked = deferred<void>(); let short = false, ticks = 0;
  const port = await f.connected({ clock: () => short ? (++ticks === 1 ? 0 : 44_999) : 0, persist: async bytes => {
    entered.resolve(); await blocked.promise; await f.persist(bytes);
  } });
  short = true; const running = port.revokeProviderAccess(); await entered.promise;
  await expect(running).rejects.toThrow("timeout"); expect(f.forms).toEqual([]); expect((await port.health()).state).toBe("disabled");
  blocked.resolve(); await Bun.sleep(10); expect(parseState(f.state).revocation).toBe("pending");
  const gets = f.requests.length, restored = await f.connected(); expect(f.requests).toHaveLength(gets); expect((await restored.sync(null)).status).toBe("unavailable");
  await restored.revokeProviderAccess(); expect(f.forms).toHaveLength(2); expect(parseState(f.state).revocation).toBe("revoked");
});
