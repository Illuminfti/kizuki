import { expect, test } from 'bun:test';
import { inspectXApiState, assertSameXApiIdentity, createXApiConnector } from '../../src/api';
import { XApiFixture } from '../../src/api/testkit';
import { digest, encodeState, parseState, X_API_STATE_SCHEMA, newCredentialGeneration } from '../../src/api/state';

test('X host inspection projects identity and selection without credential or history payloads', () => {
  const f = new XApiFixture(1), projected = inspectXApiState(f.state);
  expect(Object.keys(projected).sort()).toEqual(['account_id', 'app_digest', 'native_client', 'recovery_required', 'revocation', 'selection']);
  expect(projected).toEqual({ account_id: f.account, app_digest: digest(f.clientId), revocation: 'active', selection: f.selected, native_client: { id: f.clientId, redirect_uri: 'http://127.0.0.1:49152/callback' }, recovery_required: false });
  expect(JSON.stringify(projected)).not.toContain('SYNTHETIC_X');
  expect(() => inspectXApiState(new TextEncoder().encode('{"oauth":"private"}'))).toThrow();
});

test('X replacement assertion preserves every noncredential custody dimension', async () => {
  const f = new XApiFixture(1), port = await f.connected(); await port.backfill(null); await port.close();
  const original = parseState(f.state); expect(original.pending).not.toBeNull();
  original.retry_at = '2026-02-02T00:00:00Z'; const before = encodeState(original);
  const rotated = structuredClone(original); if (rotated.schema !== X_API_STATE_SCHEMA) throw Error('expected v2 fixture'); rotated.credential_generation = newCredentialGeneration(); rotated.oauth.tokens.access_token = 'synthetic-new-access'; rotated.oauth.tokens.refresh_token = 'synthetic-new-refresh';
  expect(() => assertSameXApiIdentity(before, encodeState(rotated))).not.toThrow();
  for (const change of ['account', 'app', 'selection', 'pending', 'retry', 'revocation'] as const) {
    const next = structuredClone(rotated);
    if (change === 'account') { next.oauth.account.id = '8'; next.pending = null; next.checkpoint = null; }
    if (change === 'app') next.app = digest('another-app');
    if (change === 'selection') { next.selection.fields = ['links']; next.pending = null; next.checkpoint = null; }
    if (change === 'pending') next.pending = null;
    if (change === 'retry') next.retry_at = null;
    if (change === 'revocation') next.revocation = 'pending';
    expect(() => assertSameXApiIdentity(before, encodeState(next))).toThrow();
  }
  const pendingRevoke = structuredClone(original); pendingRevoke.revocation = 'pending';
  expect(() => assertSameXApiIdentity(encodeState(pendingRevoke), encodeState(rotated))).toThrow();
});

test('generic X enrollment preserves Core manual callback after opener rejection', async () => {
  const f = new XApiFixture(1); f.authorize = true;
  const connector = createXApiConnector(f.config(), f.deps()); let saved = false;
  const io = { ...f.io, openUrl: async (raw: string) => {
    setTimeout(() => { void f.io.openUrl(raw); }, 1);
    throw Error('synthetic opener rejection');
  } };
  await connector.signIn(io, { write: async () => { saved = true; } }, { mode: 'new' });
  expect(saved).toBe(true); expect(f.listenerClosed).toBe(true); await connector.closeForHost();
});
