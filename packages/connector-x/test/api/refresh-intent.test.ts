import { expect, test } from 'bun:test';
import { createXApiConnector, inspectXApiState } from '../../src/api';
import { XApiFixture } from '../../src/api/testkit';
import { digest, encodeState, parseState, X_API_STATE_SCHEMA, X_API_LEGACY_STATE_SCHEMA, type XApiStateV2 } from '../../src/api/state';
function v2(bytes: Uint8Array): XApiStateV2 { const state = parseState(bytes); if (state.schema !== X_API_STATE_SCHEMA) throw Error('v2 required'); return state; }
function expired(f: XApiFixture) { const state = v2(f.state); state.oauth.tokens.expires_at = '2020-01-01T00:00:00Z'; f.state = encodeState(state); }

test('a committed exact refresh intent precedes POST, and only a committed response changes credential generation', async () => {
  const f = new XApiFixture(1); expired(f); const before = v2(f.state), writes: XApiStateV2[] = [];
  f.beforeToken = async () => {
    const state = v2(f.state), intent = state.refresh_pending!;
    expect(writes).toHaveLength(1); expect(intent).toEqual({ intent_id: expect.stringMatching(/^[a-f0-9]{64}$/), generation: before.credential_generation, account: f.account, app: before.app, scope_digest: digest(before.oauth.tokens.scope) });
    expect(state.oauth).toEqual(before.oauth); expect(f.requests).toEqual([]);
  };
  const connector = await f.connected({ persist: async bytes => { writes.push(v2(bytes)); await f.persist(bytes); } });
  expect(writes).toHaveLength(2); expect(writes[0]!.refresh_pending).not.toBeNull(); expect(writes[1]!.refresh_pending).toBeNull();
  expect(writes[1]!.credential_generation).toMatch(/^[a-f0-9]{64}$/); expect(writes[1]!.credential_generation).not.toBe(before.credential_generation);
  expect(writes[1]!.oauth.tokens.refresh_token).toBe(f.refresh); expect(f.forms).toHaveLength(1); await connector.closeForHost();
});

test('failed pre-refresh intent write makes zero provider requests', async () => {
  const f = new XApiFixture(1); expired(f); const before = f.state.slice();
  await expect(f.connected({ persist: async () => { throw Error('synthetic intent publication refusal'); } })).rejects.toThrow();
  expect(f.forms).toEqual([]); expect(f.requests).toEqual([]); expect(f.state).toEqual(before);
});

for (const outcome of ['lost', 'malformed', 'scope'] as const) test(`unknown ${outcome} outcome remains durable and refuses all default reuse`, async () => {
  const f = new XApiFixture(1); expired(f);
  f.beforeToken = async () => {
    if (outcome === 'lost') throw Error('synthetic lost response after provider boundary');
    return { status: 200, body: outcome === 'malformed' ? { bad: 'SYNTHETIC_TOKEN_BODY' } : { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, scope: 'tweet.read', token_type: 'Bearer' } };
  };
  await expect(f.connected()).rejects.toThrow(); expect(f.forms).toHaveLength(1);
  const pending = f.state.slice(); expect(inspectXApiState(pending).recovery_required).toBe(true);
  await expect(f.connected()).rejects.toThrow('credential_recovery_required'); expect(f.forms).toHaveLength(1); expect(f.requests).toEqual([]);
  const ordinary = createXApiConnector(f.config(), f.deps());
  await expect(ordinary.signIn(f.io, { write: async () => { throw Error('must not write'); } }, { mode: 'replace', previous_state: pending })).rejects.toThrow('credential_recovery_required');
  expect(f.authorizations).toEqual([]); expect(f.state).toEqual(pending); await ordinary.closeForHost();
});

test('legacy v1 is strict and upgrades with explicit public configuration before its first refresh', async () => {
  const f = new XApiFixture(1); expired(f);
  const raw = JSON.parse(new TextDecoder().decode(f.state)); raw.schema = X_API_LEGACY_STATE_SCHEMA;
  delete raw.native_client; delete raw.credential_generation; delete raw.refresh_pending;
  f.state = new TextEncoder().encode(JSON.stringify(raw));
  expect(inspectXApiState(f.state)).toMatchObject({ native_client: null, recovery_required: false });
  const bad = { ...raw, native_client: { id: f.clientId, redirect_uri: 'http://127.0.0.1:49152/callback' } };
  expect(() => parseState(new TextEncoder().encode(JSON.stringify(bad)))).toThrow();
  const noCallback = { ...f.config() }; delete noCallback.redirect_uri;
  await expect(createXApiConnector(noCallback, f.deps()).connect(async () => new TextDecoder().decode(f.state))).rejects.toThrow(); expect(f.forms).toEqual([]);
  const connector = await f.connected(); expect(v2(f.state).native_client).toEqual({ id: f.clientId, redirect_uri: 'http://127.0.0.1:49152/callback' }); await connector.closeForHost();
});

test('strict v2 refuses malformed native app configuration, generation and intent bindings', () => {
  const f = new XApiFixture(1), base = v2(f.state);
  for (const fault of ['extra', 'uppercase', 'short', 'client', 'callback', 'intent-extra', 'intent-account', 'intent-app', 'intent-scope', 'intent-generation'] as const) {
    const raw: Record<string, any> = structuredClone(base);
    if (fault === 'extra') raw.hidden = true;
    if (fault === 'uppercase') raw.credential_generation = 'A'.repeat(64);
    if (fault === 'short') raw.credential_generation = 'a'.repeat(63);
    if (fault === 'client') raw.native_client.id = 'different-app';
    if (fault === 'callback') raw.native_client.redirect_uri = 'http://localhost:49152/callback';
    if (fault.startsWith('intent')) {
      raw.refresh_pending = { intent_id: 'b'.repeat(64), generation: base.credential_generation, account: f.account, app: base.app, scope_digest: digest(base.oauth.tokens.scope) };
      if (fault === 'intent-extra') raw.refresh_pending.hidden = true;
      if (fault === 'intent-account') raw.refresh_pending.account = '8';
      if (fault === 'intent-app') raw.refresh_pending.app = 'c'.repeat(64);
      if (fault === 'intent-scope') raw.refresh_pending.scope_digest = 'c'.repeat(64);
      if (fault === 'intent-generation') raw.refresh_pending.generation = 'c'.repeat(64);
    }
    expect(() => parseState(new TextEncoder().encode(JSON.stringify(raw)))).toThrow('invalid_state');
  }
});
