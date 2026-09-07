import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConnectionStateStore, listConnections, setSourceGrant } from '@kizuki/core';
import { openLedger } from '@kizuki/core/testing';
import { createXApiConnector, type XApiConfig, X_API_SCOPES } from '@kizuki/connectors';
import { XApiFixture } from '../../connector-x/src/api/testkit';
import { encodeState, parseState } from '../../connector-x/src/api/state';
import { closeHostConnector, loadConnector, selectConnection } from '../src/connections';
import { withVault } from '../src/context';
import { createHelpers } from './helpers';
import type { CliIo } from '../src/commands';
const h = createHelpers(); afterEach(h.cleanup);

for (const delayed of ['response', 'write'] as const) test(`X host drains late ${delayed} custody on the original native state handle`, async () => {
  const setup = h.tempVault(), f = new XApiFixture(1), state = parseState(f.state);
  state.oauth.tokens.expires_at = '2020-01-01T00:00:00Z'; f.state = encodeState(state);
  const path = join(setup.vault, '.kizuki/kizuki.db'), store = new ConnectionStateStore(join(setup.vault, '.kizuki'));
  let db = openLedger(path), release!: () => void, enter!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  const pending = store.begin(); await pending.writer.write(f.state); const saved = store.save(db, 'kizuki.x', pending.pending);
  setSourceGrant(db, { source_key: saved.source_key, expected_revision: 0, operation_id: 'synthetic-x-drain-grant', policy: { purposes: ['capture'], allowed_fields: ['text', 'metadata'], retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private' } }); db.close();
  const io: CliIo = { env: { ...setup.env, KIZUKI_X_CLIENT_ID: f.clientId, KIZUKI_X_REDIRECT_URI: 'http://127.0.0.1:49152/callback' }, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: () => {}, err: () => {}, prompt: async () => { throw Error(); } };
  let connector: ReturnType<typeof createXApiConnector> | undefined, finished = false;
  const run = withVault(io, async ctx => {
    const loading = loadConnector(selectConnection(ctx.db, ctx.store, 'kizuki.x', saved.source_key), ctx.store, ctx.db, io.env, (_id, config, deps) => {
      connector = createXApiConnector(config as XApiConfig, { fetch: f.fetch, now: f.now,
        persist: async bytes => { if (delayed === 'write') { enter(); await hold; } await deps!.persist!(bytes); },
        oauth: { listen: async () => { throw Error('not enrollment'); }, postForm: async () => {
          if (delayed === 'response') { enter(); await hold; }
          return { status: 200, body: { access_token: 'synthetic-drained-access', refresh_token: 'synthetic-drained-refresh', expires_in: 3600, scope: X_API_SCOPES.join(' '), token_type: 'Bearer' } };
        } } }); return connector;
    });
    await started;
    const closing = closeHostConnector(connector!).then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    await expect(connector!.sync(null)).rejects.toThrow();
    release(); await expect(loading).rejects.toThrow('X connection unavailable'); await closing;
  }, { retrieval: 'none' });
  try { await run; expect(finished).toBe(true); }
  finally { release(); }
  db = openLedger(path);
  try { expect(parseState(store.read(listConnections(db)[0]!)!).oauth.tokens.refresh_token).toBe('synthetic-drained-refresh'); }
  finally { db.close(); }
});

test('X host timeout reports unknown custody while late settlement remains fenced and recoverable', async () => {
  const f = new XApiFixture(1), state = parseState(f.state); state.oauth.tokens.expires_at = '2020-01-01T00:00:00Z'; f.state = encodeState(state);
  let release!: (value: {status: number; body: unknown}) => void, enter!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const connector = createXApiConnector(f.config(), f.deps({ oauth: { listen: async () => { throw Error(); }, postForm: async () => { enter(); return new Promise(resolve => { release = resolve; }); } } }));
  const connecting = connector.connect(async () => new TextDecoder().decode(f.state)).catch(() => {});
  await started;
  try { await expect(closeHostConnector(connector)).rejects.toThrow('credential_custody_unknown'); await expect(connector.sync(null)).rejects.toThrow(); }
  finally {
    release({ status: 200, body: { access_token: 'synthetic-after-timeout-access', refresh_token: 'synthetic-after-timeout-refresh', expires_in: 3600, scope: X_API_SCOPES.join(' '), token_type: 'Bearer' } });
    await connecting; await closeHostConnector(connector);
  }
  expect(parseState(f.state).oauth.tokens.refresh_token).toBe('synthetic-after-timeout-refresh');
}, 10000);
