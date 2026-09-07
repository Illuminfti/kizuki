import { afterEach, expect, test } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionStateStore, createStatePersister, inspectSourceGrant, listConnections, revokeSourceGrant, setSourceGrant } from '@kizuki/core';
import { openLedger } from '@kizuki/core/testing';
import { createXApiConnector, inspectXApiState, X_API_SCOPES, type XApiConfig, type XApiDeps } from '@kizuki/connectors';
import { XApiFixture } from '../../connector-x/src/api/testkit';
import { encodeState, parseState, X_API_STATE_SCHEMA, type XApiStateV2 } from '../../connector-x/src/api/state';
import { loadConnector, selectConnection, closeHostConnector } from '../src/connections';
import { runXApiConnect, runXApiRecovery } from '../src/commands/connect-x-api';
import { withVault } from '../src/context';
import { createHelpers } from './helpers';
import type { CliIo } from '../src/commands';
const h = createHelpers(); afterEach(h.cleanup);
const ID = 'kizuki.x';
function v2(bytes: Uint8Array): XApiStateV2 { const state = parseState(bytes); if (state.schema !== X_API_STATE_SCHEMA) throw Error('expected v2'); return state; }
function stateStore(setup: ReturnType<typeof h.tempVault>) { return new ConnectionStateStore(join(setup.vault, '.kizuki')); }
function dbPath(setup: ReturnType<typeof h.tempVault>) { return join(setup.vault, '.kizuki/kizuki.db'); }
function ownerIo(setup: ReturnType<typeof h.tempVault>) {
  const output: string[] = [];
  const io: CliIo = { env: { ...setup.env }, vaultOverride: setup.vault, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true,
    out: line => output.push(line), err: line => output.push(line), prompt: async () => { throw Error('no pasted credentials'); } };
  return { io, output };
}
async function enrolled(expired = true) {
  const setup = h.tempVault(), f = new XApiFixture(1), state = v2(f.state);
  const socket = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  state.native_client.redirect_uri = `http://127.0.0.1:${socket.port}/callback`; await socket.stop(true);
  if (expired) state.oauth.tokens.expires_at = '2020-01-01T00:00:00Z'; f.state = encodeState(state);
  const db = openLedger(dbPath(setup)), store = stateStore(setup), pending = store.begin();
  await pending.writer.write(f.state); const connection = store.save(db, ID, pending.pending);
  setSourceGrant(db, { source_key: connection.source_key, expected_revision: 0, operation_id: 'synthetic-recovery-grant', policy: {
    purposes: ['capture'], allowed_fields: ['text', 'metadata'], retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private',
  } }); db.close();
  return { setup, f, source: connection.source_key, redirect: state.native_client.redirect_uri, ...ownerIo(setup) };
}
function readState(setup: ReturnType<typeof h.tempVault>) {
  const db = openLedger(dbPath(setup)); try { const connection = listConnections(db)[0]!; return stateStore(setup).read(connection)!; } finally { db.close(); }
}
function runtime(f: XApiFixture, extras: XApiDeps = {}) {
  return (_id: string, config?: unknown, deps?: { persist?: (bytes: Uint8Array) => Promise<void> }) => createXApiConnector(config as XApiConfig, { ...deps, fetch: f.fetch, now: f.now, oauth: f.oauth, ...extras });
}
function nativeBrowser(f: XApiFixture, redirect: string) {
  return {
    create: (config: XApiConfig, deps: XApiDeps) => createXApiConnector(config, { ...deps, fetch: f.fetch, now: f.now, oauth: { ...deps.oauth!, postForm: f.oauth.postForm } }),
    open: async (raw: string) => { const url = new URL(raw); expect(url.searchParams.get('redirect_uri')).toBe(redirect); expect(url.searchParams.get('code_challenge_method')).toBe('S256'); const callback = new URL(redirect); callback.searchParams.set('code', 'synthetic-recovery-code'); callback.searchParams.set('state', url.searchParams.get('state')!); expect((await fetch(callback)).status).toBe(200); },
  };
}
function options(source: string) { return { source, fields: 'none', historyStart: '2026-01-01T00:00:00Z', json: true }; }
/** A real new process with no provider env. Only content-free status/counters leave it. */
function freshProcess(o: Awaited<ReturnType<typeof enrolled>>, action: 'runtime' | 'reauth') {
  const script = join(o.setup.root, `fresh-${action}.ts`);
  writeFileSync(script, `import { openLedger } from ${JSON.stringify(join(import.meta.dir, '../../core/src/ledger/db.ts'))};
import { ConnectionStateStore } from ${JSON.stringify(join(import.meta.dir, '../../core/src/ledger/connection-state.ts'))};
import { loadConnector, selectConnection, closeHostConnector } from ${JSON.stringify(join(import.meta.dir, '../src/connections.ts'))};
import { runXApiConnect } from ${JSON.stringify(join(import.meta.dir, '../src/commands/connect-x-api.ts'))};
import { createXApiConnector } from ${JSON.stringify(join(import.meta.dir, '../../connector-x/src/api/connector.ts'))};
import { XApiFixture } from ${JSON.stringify(join(import.meta.dir, '../../connector-x/src/api/testkit.ts'))};
if (process.env.KIZUKI_X_CLIENT_ID !== undefined || process.env.KIZUKI_X_REDIRECT_URI !== undefined) throw Error('provider environment must be absent');
const f = new XApiFixture(1), db = openLedger(${JSON.stringify(dbPath(o.setup))}), store = new ConnectionStateStore(${JSON.stringify(join(o.setup.vault, '.kizuki'))}); let factories = 0, result = 'unexpected';
const io = { env: ${JSON.stringify(o.setup.env)}, vaultOverride: ${JSON.stringify(o.setup.vault)}, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true, out: () => {}, err: () => {}, prompt: async () => { throw Error('no prompt'); } };
try {
 if (${JSON.stringify(action)} === 'reauth') await runXApiConnect(io, ${JSON.stringify(options(o.source))}, () => {}, () => { factories++; throw Error('unexpected factory'); }, async () => { throw Error('unexpected browser'); });
 else { const port = await loadConnector(selectConnection(db, store, 'kizuki.x', ${JSON.stringify(o.source)}), store, db, process.env, (_id, config, deps) => { factories++; return createXApiConnector(config, { ...deps, fetch: f.fetch, now: f.now, oauth: f.oauth }); }); await closeHostConnector(port); result = 'connected'; }
} catch (error) { result = error instanceof Error && error.message.includes('credential_recovery_required') ? 'credential_recovery_required' : 'unexpected_failure'; }
finally { db.close(); }
process.stdout.write(JSON.stringify({ result, factories, posts: f.forms.length, gets: f.requests.length }));`);
  const env = { ...process.env }; delete env.KIZUKI_X_CLIENT_ID; delete env.KIZUKI_X_REDIRECT_URI;
  const child = Bun.spawnSync([process.execPath, script], { env, stdout: 'pipe', stderr: 'pipe', timeout: 8000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0); return JSON.parse(child.stdout.toString());
}
async function loseResponse(o: Awaited<ReturnType<typeof enrolled>>) {
  o.f.beforeToken = async () => { throw Error('synthetic response lost after provider boundary'); };
  await expect(withVault(o.io, async ctx => loadConnector(selectConnection(ctx.db, ctx.store, ID, o.source), ctx.store, ctx.db, {}, runtime(o.f)), { retrieval: 'none' })).rejects.toThrow();
  delete o.f.beforeToken; expect(v2(readState(o.setup)).refresh_pending).not.toBeNull();
}

for (const expired of [false, true]) test(`fresh background process uses persisted v2 public app configuration with no provider environment: expired=${expired}`, async () => {
  const o = await enrolled(expired), before = v2(readState(o.setup));
  expect(freshProcess(o, 'runtime')).toEqual({ result: 'connected', factories: 1, posts: expired ? 1 : 0, gets: 1 });
  const after = v2(readState(o.setup)); expect(after.native_client).toEqual(before.native_client); expect(after.refresh_pending).toBeNull();
  if (expired) expect(after.credential_generation).not.toBe(before.credential_generation);
});

test('native pre-refresh commit failure sends no request and restores the original state', async () => {
  const o = await enrolled(), db = openLedger(dbPath(o.setup)), before = readState(o.setup), store = stateStore(o.setup);
  try {
    db.exec("CREATE TRIGGER synthetic_intent_commit_failure BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT, 'synthetic intent refused'); END");
    await expect(loadConnector(selectConnection(db, store, ID, o.source), store, db, {}, runtime(o.f))).rejects.toThrow();
    expect(o.f.forms).toEqual([]); expect(o.f.requests).toEqual([]); expect(readState(o.setup)).toEqual(before);
    expect(readdirSync(store.directory)).toEqual([`${o.source}.state`]);
  } finally { db.exec('DROP TRIGGER synthetic_intent_commit_failure'); db.close(); }
});

test('lost response and actual native DB closure leave a durable fence across fresh runtime and default reauthorization', async () => {
  const o = await enrolled(); await loseResponse(o); const pending = readState(o.setup);
  for (const action of ['runtime', 'reauth'] as const) expect(freshProcess(o, action)).toEqual({ result: 'credential_recovery_required', factories: 0, posts: 0, gets: 0 });
  expect(readState(o.setup)).toEqual(pending); expect(o.f.forms).toHaveLength(1);
});

test('unknown host timeout closes its native DB; explicit recovery wins while the old response is still held', async () => {
  const o = await enrolled(); let entered!: () => void, release!: (value: { status: number; body: unknown }) => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); let oldPort: ReturnType<typeof createXApiConnector> | undefined;
  const running = withVault(o.io, async ctx => loadConnector(selectConnection(ctx.db, ctx.store, ID, o.source), ctx.store, ctx.db, {}, (_id, config, deps) => {
    oldPort = createXApiConnector(config as XApiConfig, { ...deps, fetch: o.f.fetch, now: o.f.now, oauth: { listen: async () => { throw Error('runtime'); }, postForm: async () => { entered(); return new Promise(resolve => { release = resolve; }); } } }); return oldPort;
  }), { retrieval: 'none' });
  const rejected = running.catch(error => error); await started;
  try {
    expect((await rejected).message).toContain('credential_custody_unknown');
    const pending = v2(readState(o.setup)); expect(pending.refresh_pending).not.toBeNull();
    for (const action of ['runtime', 'reauth'] as const) expect(freshProcess(o, action)).toEqual({ result: 'credential_recovery_required', factories: 0, posts: 0, gets: 0 });
    const browser = nativeBrowser(o.f, o.redirect);
    expect(await runXApiRecovery(o.io, options(o.source), () => {}, browser.create, browser.open)).toBe(0);
    const recovered = readState(o.setup), state = v2(recovered);
    expect(state.refresh_pending).toBeNull(); expect(state.credential_generation).not.toBe(pending.credential_generation);
    expect(state.checkpoint).toBe(pending.checkpoint); expect(state.pending).toEqual(pending.pending); expect(state.retry_at).toBe(pending.retry_at);
    release({ status: 200, body: { access_token: 'synthetic-late-old-access', refresh_token: 'synthetic-late-old-refresh', expires_in: 3600, scope: X_API_SCOPES.join(' '), token_type: 'Bearer' } });
    await oldPort!.closeForHost(); expect(readState(o.setup)).toEqual(recovered);
    const db = openLedger(dbPath(o.setup)); try { expect(inspectSourceGrant(db, o.source)?.revision).toBe(1); } finally { db.close(); }
    expect(o.output.join('\n')).toContain('does not retry old credentials'); expect(o.output.join('\n')).not.toContain('synthetic-late-old');
  } finally {
    release({ status: 500, body: {} }); await rejected; await oldPort?.closeForHost();
  }
}, 20000);

test('recovery replaces the pending generation before a late response on a still-open old CAS handle', async () => {
  const o = await enrolled(), db = openLedger(dbPath(o.setup)), store = stateStore(o.setup);
  let release!: (value: { status: number; body: unknown }) => void, enter!: () => void, staleWrites = 0;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const original = listConnections(db)[0]!, handle = createStatePersister(db, store, original);
  const connector = createXApiConnector({ client_id: o.f.clientId, redirect_uri: o.redirect, secret_ref: original.secret_refs[0]!, selection: o.f.selected }, {
    fetch: o.f.fetch, now: o.f.now, persist: async bytes => { try { await handle.persist(bytes); } catch (error) { staleWrites++; throw error; } },
    oauth: { listen: async () => { throw Error('runtime'); }, postForm: async () => { enter(); return new Promise(resolve => { release = resolve; }); } },
  });
  const connecting = connector.connect(async () => new TextDecoder().decode(store.read(original)!)).catch(error => error); await started;
  try {
    const pending = v2(readState(o.setup)), browser = nativeBrowser(o.f, o.redirect);
    await runXApiRecovery(o.io, options(o.source), () => {}, browser.create, browser.open);
    const recovered = readState(o.setup); expect(v2(recovered).credential_generation).not.toBe(pending.credential_generation);
    release({ status: 200, body: { access_token: 'synthetic-stale-response-access', refresh_token: 'synthetic-stale-response-refresh', expires_in: 3600, scope: X_API_SCOPES.join(' '), token_type: 'Bearer' } });
    expect(await connecting).toBeInstanceOf(Error); await connector.closeForHost();
    expect(staleWrites).toBe(1); expect(readState(o.setup)).toEqual(recovered);
  } finally { release({ status: 500, body: {} }); await connecting; await connector.closeForHost(); db.close(); }
});

for (const fault of ['account', 'grant-race', 'publication'] as const) test(`failed explicit recovery ${fault} preserves the pending intent and source authority`, async () => {
  const o = await enrolled(); await loseResponse(o); const before = readState(o.setup), browser = nativeBrowser(o.f, o.redirect), db = openLedger(dbPath(o.setup));
  if (fault === 'account') o.f.before = async () => Response.json({ data: { id: '8' } });
  if (fault === 'publication') db.exec("CREATE TRIGGER synthetic_recovery_failure BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT, 'synthetic recovery commit refused'); END");
  try {
    await expect(runXApiRecovery(o.io, options(o.source), () => {}, browser.create, async raw => {
      if (fault === 'grant-race') revokeSourceGrant(db, { source_key: o.source, expected_revision: 1, operation_id: 'synthetic-recovery-revoke' });
      await browser.open(raw);
    })).rejects.toThrow();
    expect(readState(o.setup)).toEqual(before); expect(inspectSourceGrant(db, o.source)?.revision).toBe(fault === 'grant-race' ? 2 : 1);
    await expect(fetch(o.redirect)).rejects.toThrow();
  } finally { if (fault === 'publication') db.exec('DROP TRIGGER synthetic_recovery_failure'); db.close(); }
});

test('explicit recovery cannot restore withdrawn capture authority', async () => {
  const o = await enrolled(); await loseResponse(o); const db = openLedger(dbPath(o.setup));
  try {
    revokeSourceGrant(db, { source_key: o.source, expected_revision: 1, operation_id: 'synthetic-prior-withdrawal' });
    const grant = inspectSourceGrant(db, o.source), browser = nativeBrowser(o.f, o.redirect);
    await runXApiRecovery(o.io, options(o.source), () => {}, browser.create, browser.open);
    expect(v2(readState(o.setup)).refresh_pending).toBeNull(); expect(inspectSourceGrant(db, o.source)).toEqual(grant);
    const beforeRequests = [o.f.forms.length, o.f.requests.length];
    await expect(loadConnector(selectConnection(db, stateStore(o.setup), ID, o.source), stateStore(o.setup), db, {}, runtime(o.f))).rejects.toThrow('source_capture_denied');
    expect([o.f.forms.length, o.f.requests.length]).toEqual(beforeRequests);
  } finally { db.close(); }
});

for (const revocation of ['pending', 'revoked'] as const) test(`explicit recovery refuses ${revocation} provider revocation before factory or browser`, async () => {
  const o = await enrolled(); await loseResponse(o); const db = openLedger(dbPath(o.setup)), store = stateStore(o.setup);
  try {
    const connection = listConnections(db)[0]!, state = v2(store.read(connection)!); state.revocation = revocation;
    await createStatePersister(db, store, connection).persist(encodeState(state)); const before = readState(o.setup);
    let factories = 0, browsers = 0;
    await expect(runXApiRecovery(o.io, options(o.source), () => {}, () => { factories++; throw Error('factory must not run'); }, async () => { browsers++; })).rejects.toThrow('credential_recovery_required');
    expect(factories).toBe(0); expect(browsers).toBe(0); expect(readState(o.setup)).toEqual(before);
  } finally { db.close(); }
});

test('nested native transaction cannot publish a refresh fence or send a provider request', async () => {
  const o = await enrolled(), db = openLedger(dbPath(o.setup)), store = stateStore(o.setup), before = readState(o.setup);
  try {
    const files = readdirSync(store.directory).map(name => [name, readFileSync(join(store.directory, name)).toString('hex')]);
    db.exec('BEGIN IMMEDIATE');
    await expect(loadConnector(selectConnection(db, store, ID, o.source), store, db, {}, runtime(o.f))).rejects.toThrow();
    expect(o.f.forms).toEqual([]); expect(o.f.requests).toEqual([]);
    expect(readdirSync(store.directory).map(name => [name, readFileSync(join(store.directory, name)).toString('hex')])).toEqual(files);
    db.exec('ROLLBACK'); expect(readState(o.setup)).toEqual(before);
  } finally { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); }
});
