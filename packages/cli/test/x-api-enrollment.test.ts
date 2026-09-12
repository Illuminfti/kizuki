import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionStateStore, createStatePersister, getCheckpoint, inspectSourceGrant, listConnections, replayLive, revokeSourceGrant, runToCompletion, setSourceGrant, withDeadline } from '@kizuki/core';
import { openLedger } from '@kizuki/core/testing';
import { createXApiConnector, inspectXApiState, X_API_SCOPES, type XApiConfig, type XApiDeps } from '@kizuki/connectors';
import { XApiFixture } from '../../connector-x/src/api/testkit';
import { encodeState, parseState } from '../../connector-x/src/api/state';
import { runXApiConnect } from '../src/commands/connect-x-api';
import { closeHostConnector, listHostConnections, loadConnector, selectConnection } from '../src/connections';
import { xApiClient, xApiRequiredFields, xApiSelection } from '../src/x-api';
import { printConnectorCatalog } from '../src/connect-catalog';
import { createAppHost } from '../src/app/host';
import { createHelpers } from './helpers';
import type { CliIo } from '../src/commands';
const h = createHelpers(); afterEach(h.cleanup);
const ID = 'kizuki.x', fields = 'none', historyStart = '2026-01-01T00:00:00Z';
const options = { fields, historyStart, json: true };
async function unusedCallback() {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const uri = `http://127.0.0.1:${server.port}/callback`; await server.stop(true); return uri;
}
async function owner(setup: ReturnType<typeof h.tempVault>, f = new XApiFixture(3)) {
  const output: string[] = [];
  const existingDb = openLedger(join(setup.vault, '.kizuki/kizuki.db')), existingStore = new ConnectionStateStore(join(setup.vault, '.kizuki'));
  let priorRedirect: string | undefined;
  try { const first = listConnections(existingDb)[0]; if (first) priorRedirect = inspectXApiState(existingStore.read(first)!).native_client?.redirect_uri; } finally { existingDb.close(); }
  const redirect = priorRedirect ?? await unusedCallback();
  const io: CliIo = { env: { ...setup.env, KIZUKI_X_CLIENT_ID: f.clientId, KIZUKI_X_REDIRECT_URI: redirect }, vaultOverride: setup.vault,
    stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true, out: line => output.push(line), err: line => output.push(line), prompt: async () => { throw Error('pasted credentials forbidden'); } };
  let opens = 0, auth: URL | undefined;
  const create = (config: XApiConfig, deps: XApiDeps) => createXApiConnector(config, { ...deps, oauth: { ...deps.oauth!, postForm: f.oauth.postForm }, fetch: f.fetch, now: f.now });
  const open = async (raw: string) => {
    opens++; auth = new URL(raw);
    expect(auth.origin).toBe('https://x.com'); expect(auth.pathname).toBe('/i/oauth2/authorize');
    expect(auth.searchParams.get('redirect_uri')).toBe(redirect);
    expect(auth.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('scope')).toBe(X_API_SCOPES.join(' '));
    const callback = new URL(redirect); callback.searchParams.set('code', 'synthetic-code'); callback.searchParams.set('state', auth.searchParams.get('state')!);
    const response = await fetch(callback); expect(response.status).toBe(200); expect(await response.text()).not.toContain('synthetic-code');
  };
  return { io, output, f, create, open, redirect, opens: () => opens, auth: () => auth! };
}
function ledger(setup: ReturnType<typeof h.tempVault>) {
  return { db: openLedger(join(setup.vault, '.kizuki/kizuki.db')), store: new ConnectionStateStore(join(setup.vault, '.kizuki')) };
}
function grant(db: ReturnType<typeof openLedger>, source: string, allowed_fields: ('text' | 'subjects' | 'attachments' | 'metadata')[] = ['text', 'subjects', 'attachments', 'metadata']) {
  setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: 'synthetic-x-grant', policy: { purposes: ['capture'], allowed_fields, retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private' } });
}
function runtime(f: XApiFixture) {
  return (_id: string, config?: unknown, deps?: { persist?: (bytes: Uint8Array) => Promise<void> }) => createXApiConnector(config as XApiConfig, { ...deps, fetch: f.fetch, now: f.now, oauth: f.oauth });
}

test('real loopback OAuth enrollment persists private state, grants capture separately, resumes and preserves pending history on reauthorization', async () => {
  const setup = h.tempVault(), o = await owner(setup);
  expect(await runXApiConnect(o.io, options, () => {}, o.create, o.open)).toBe(0);
  expect(o.opens()).toBe(1); expect(o.f.forms).toHaveLength(1);
  const form = o.f.forms[0]!.form;
  expect(Object.keys(form).sort()).toEqual(['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
  expect(form.redirect_uri).toBe(o.redirect); expect(form.client_id).toBe(o.f.clientId);
  expect(createHash('sha256').update(form.code_verifier!).digest('base64url')).toBe(o.auth().searchParams.get('code_challenge')!);
  await expect(fetch(o.redirect)).rejects.toThrow();
  let { db, store } = ledger(setup);
  try {
    let connection = listConnections(db)[0]!; const source = connection.source_key;
    expect([...replayLive(db)]).toHaveLength(0); expect(inspectSourceGrant(db, source)).toBeNull();
    expect(inspectXApiState(store.read(connection)!)).toMatchObject({ account_id: o.f.account, selection: o.f.selected });
    expect(statSync(join(setup.vault, '.kizuki', connection.secret_refs[0]!.slice(5))).mode & 0o777).toBe(0o600);
    const load = () => loadConnector(selectConnection(db, store, ID, source), store, db, o.io.env, runtime(o.f));
    const read = spyOn(store, 'read'); const before = o.f.requests.length;
    try {
      expect(listHostConnections(db, store, ID)).toHaveLength(1);
      await expect(load()).rejects.toThrow('source_capture_denied');
      expect(read).not.toHaveBeenCalled(); expect(o.f.requests).toHaveLength(before);
    } finally { read.mockRestore(); }
    grant(db, source);
    const initial = await load();
    expect((await runToCompletion(db, initial, ID, source, 'backfill', { maxBatches: 1 })).stored).toBe(2);
    await closeHostConnector(initial);
    connection = listConnections(db)[0]!;
    const previous = parseState(store.read(connection)!);
    expect(previous.pending).not.toBeNull();
    previous.retry_at = '2026-02-01T00:00:30Z';
    await createStatePersister(db, store, connection).persist(encodeState(previous));
    const checkpoint = getCheckpoint(db, ID, source);
    const again = await owner(setup, o.f);
    expect(await runXApiConnect(again.io, { ...options, source }, () => {}, again.create, again.open)).toBe(0);
    expect(getCheckpoint(db, ID, source)).toEqual(checkpoint);
    const next = parseState(store.read(listConnections(db)[0]!)!);
    expect(next.checkpoint).toBe(previous.checkpoint); expect(next.pending).toEqual(previous.pending); expect(next.retry_at).toBe(previous.retry_at);
    db.close(); ({ db, store } = ledger(setup)); o.f.time = new Date('2026-02-01T00:01:00Z');
    const resumed = await load(); const result = await runToCompletion(db, resumed, ID, source, 'backfill');
    expect(result.errors).toEqual([]); expect(result.stored).toBe(1); await closeHostConnector(resumed);
    const replay = await load(); expect((await runToCompletion(db, replay, ID, source, 'sync')).stored).toBe(0); await closeHostConnector(replay);
    expect([...replayLive(db)]).toHaveLength(3);
    revokeSourceGrant(db, { source_key: source, expected_revision: 1, operation_id: 'synthetic-x-revoke' });
    const revokedRead = spyOn(store, 'read'), calls = o.f.requests.length;
    try { await expect(load()).rejects.toThrow('source_capture_denied'); expect(revokedRead).not.toHaveBeenCalled(); expect(o.f.requests).toHaveLength(calls); }
    finally { revokedRead.mockRestore(); }
    const text = [...o.output, ...again.output].join('\n'); expect(text).toContain('capture_started'); expect(text).toContain('consent-required');
    for (const secret of ['SYNTHETIC_X_ACCESS_CANARY', 'SYNTHETIC_X_REFRESH_CANARY', form.code_verifier!, 'synthetic-code']) {
      expect(text).not.toContain(secret);
      for (const suffix of ['', '-wal', '-shm']) { const path = join(setup.vault, '.kizuki/kizuki.db') + suffix; if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false); }
    }
  } finally { db.close(); }
});

test('X runtime rejects incompatible fields and consent revision races before connector creation', async () => {
  const setup = h.tempVault(), o = await owner(setup); await runXApiConnect(o.io, options, () => {}, o.create, o.open);
  const { db, store } = ledger(setup);
  try {
    const source = listConnections(db)[0]!.source_key; grant(db, source, ['metadata']); let factories = 0;
    await expect(loadConnector(selectConnection(db, store, ID, source), store, db, {}, () => { factories++; throw Error(); })).rejects.toThrow('source_field_denied');
    expect(factories).toBe(0);
    setSourceGrant(db, { source_key: source, expected_revision: 1, operation_id: 'synthetic-x-fields', policy: { purposes: ['capture'], allowed_fields: ['metadata', 'text', 'subjects'], retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private' } });
    const env = { ...o.io.env };
    queueMicrotask(() => revokeSourceGrant(db, { source_key: source, expected_revision: 2, operation_id: 'synthetic-x-race' }));
    await expect(loadConnector(selectConnection(db, store, ID, source), store, db, env, () => { factories++; throw Error(); })).rejects.toThrow('source_capture_denied');
    expect(factories).toBe(0);
  } finally { db.close(); }
});

test('app host reports native X selection fields, grants exactly them, and flags corrupt protected state', async () => {
  for (const [fields, required] of [
    ['none', ['text', 'subjects', 'metadata']],
    ['links', ['text', 'subjects', 'metadata']],
    ['media', ['text', 'subjects', 'metadata', 'attachments']],
  ] as const) {
    const setup = h.tempVault(), o = await owner(setup), host = createAppHost(o.io);
    const call = async (route: string, body: unknown = {}) => (await host.handle(new Request(`http://127.0.0.1/app/v1/${route}`, { method: 'POST', body: JSON.stringify(body) }))).json() as Promise<any>;
    let db: ReturnType<typeof openLedger> | undefined;
    try {
      expect(await runXApiConnect(o.io, { fields, historyStart, json: true }, () => {}, o.create, o.open)).toBe(0);
      ({ db } = ledger(setup));
      const connection = listConnections(db)[0]!, source = connection.source_key;
      expect((await call('sources')).data.sources).toEqual([expect.objectContaining({ source_key: source, state: 'enrolled', consent: 'required', required_fields: required })]);
      const consent = await call('consent', { source_key: source, expected_revision: 0, operation_id: `app-x-${fields}`, policy: { purposes: ['capture'], allowed_fields: required, retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private' } });
      expect(consent.ok).toBe(true);
      const stored = new ConnectionStateStore(join(setup.vault, '.kizuki'));
      const loaded = await loadConnector(selectConnection(db, stored, ID, source), stored, db, o.io.env, runtime(o.f));
      await closeHostConnector(loaded);
      writeFileSync(join(setup.vault, '.kizuki', connection.secret_refs[0]!.slice(5)), 'corrupt X state');
      expect((await call('sources')).data.sources).toEqual([expect.objectContaining({ source_key: source, state: 'needs_attention', required_fields: [] })]);
    } finally { db?.close(); await host.close(); }
  }
});

test('X none/links grants retain author subjects and media/relationships unions require them before capture', async () => {
  const author = { subject_id: 'x:user:7', role: 'from' as const };
  const includes = { media: [{ media_key: '3_100', type: 'photo', url: 'https://pbs.twimg.com/media/synthetic.jpg' }] };
  for (const [fields, required, subjects, urls] of [
    ['none', ['text', 'subjects', 'metadata'], [author], false],
    ['links', ['text', 'subjects', 'metadata'], [author], true],
    ['media,relationships', ['text', 'subjects', 'metadata', 'attachments'], [author, { subject_id: 'x:user:9', role: 'to' }, { subject_id: 'x:user:8', role: 'about' }], false],
  ] as const) {
    expect(xApiRequiredFields(xApiSelection(fields, historyStart))).toEqual([...required]);
    const needsAttachments = required.some(field => field === 'attachments');
    const setup = h.tempVault(), f = new XApiFixture(1, 1, xApiSelection(fields, historyStart));
    f.records = [{ id: '100', author_id: f.account, text: 'Synthetic own reply.', created_at: '2026-01-02T00:00:00Z',
      in_reply_to_user_id: '9', entities: { mentions: [{ id: '8', username: 'peer' }], urls: [{ expanded_url: 'https://example.test/post' }] },
      attachments: { media_keys: ['3_100'] } }];
    f.before = async request => {
      const url = new URL(request.url);
      if (url.pathname !== `/2/users/${f.account}/tweets` && url.pathname !== '/2/tweets') return;
      const since = url.searchParams.get('since_id');
      const rows = f.records.filter(row => url.pathname === '/2/tweets'
        ? (url.searchParams.get('ids') ?? '').split(',').includes(String(row.id))
        : since === null || BigInt(String(row.id)) > BigInt(since)).map(row => structuredClone(row));
      return Response.json({ data: rows, meta: { result_count: rows.length, ...(rows.length === 0 ? {} : { newest_id: rows[0]!.id, oldest_id: rows.at(-1)!.id }) }, includes });
    };
    const o = await owner(setup, f);
    expect(await runXApiConnect(o.io, { fields, historyStart, json: true }, () => {}, o.create, o.open)).toBe(0);
    const { db, store } = ledger(setup);
    try {
      const source = listConnections(db)[0]!.source_key;
      let factories = 0, revision = 0;
      const load = () => loadConnector(selectConnection(db, store, ID, source), store, db, o.io.env, (_id, config, deps) => { factories++; return runtime(f)(_id, config, deps); });
      const policy = (allowed_fields: ('text' | 'subjects' | 'attachments' | 'metadata')[]) =>
        setSourceGrant(db, { source_key: source, expected_revision: revision++, operation_id: `synthetic-x-fields-${revision}`,
          policy: { purposes: ['capture'], allowed_fields, retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private' } });
      const before = f.requests.length;
      policy(['text', 'metadata']);
      await expect(load()).rejects.toThrow('source_field_denied');
      expect(factories).toBe(0); expect(f.requests).toHaveLength(before);
      if (needsAttachments) {
        policy(['text', 'subjects', 'metadata']);
        await expect(load()).rejects.toThrow('source_field_denied');
        expect(factories).toBe(0); expect(f.requests).toHaveLength(before);
      }
      policy([...required]);
      const port = await load();
      const result = await runToCompletion(db, port, ID, source, 'backfill', { maxBatches: 2 });
      expect(result.errors).toEqual([]); expect(result.stored).toBe(1); await closeHostConnector(port);
      const event = [...replayLive(db)][0]!;
      expect(event.subjects).toEqual([...subjects]);
      expect(event.attachments.map(item => item.attachment_id)).toEqual(needsAttachments ? ['3_100'] : []);
      expect(event.metadata.urls).toEqual(urls ? ['https://example.test/post'] : undefined);
      expect(event.metadata.in_reply_to_user_id).toBe(fields.includes('relationships') ? '9' : undefined);
      expect(event.metadata.references).toEqual(fields.includes('relationships') ? [] : undefined);
      expect(event.metadata.media_refs === undefined).toBe(!fields.includes('media'));
      const list = f.requests.find(request => new URL(request.url).pathname === `/2/users/${f.account}/tweets`)!;
      const tweetFields = new URL(list.url).searchParams.get('tweet.fields') ?? '';
      expect(tweetFields).toContain('author_id');
      expect(tweetFields.includes('referenced_tweets')).toBe(fields.includes('relationships'));
      expect((new URL(list.url).searchParams.get('expansions') ?? '').includes('entities.mentions.username')).toBe(fields.includes('relationships'));
      expect(o.auth().searchParams.get('scope')).toBe(X_API_SCOPES.join(' '));
    } finally { db.close(); }
  }
});

test('held X state snapshot resolves only its original reference and stale runtime writes cannot overwrite replacement', async () => {
  const setup = h.tempVault(), o = await owner(setup); await runXApiConnect(o.io, options, () => {}, o.create, o.open);
  const { db, store } = ledger(setup);
  try {
    const original = listConnections(db)[0]!; grant(db, original.source_key);
    const bytes = store.read(original)!; let held: string | undefined, persist!: (bytes: Uint8Array) => Promise<void>;
    const port = createXApiConnector();
    const read = spyOn(store, 'read');
    try {
      await loadConnector(selectConnection(db, store, ID, original.source_key), store, db, o.io.env, (_id, _config, deps) => {
        persist = deps!.persist!;
        port.connect = async resolve => {
          await expect(resolve('file:connections/unrelated.state')).rejects.toThrow('unexpected X');
          held = await resolve(original.secret_refs[0]!);
        };
        return port;
      });
      expect(read).toHaveBeenCalledTimes(1); expect(held).toBe(new TextDecoder().decode(bytes));
    } finally { read.mockRestore(); }
    const again = await owner(setup, o.f); await runXApiConnect(again.io, { ...options, source: original.source_key }, () => {}, again.create, again.open);
    const newer = store.read(listConnections(db)[0]!)!;
    await expect(persist(bytes)).rejects.toThrow(); expect(store.read(listConnections(db)[0]!)).toEqual(newer); await closeHostConnector(port);
  } finally { db.close(); }
});

test('duplicate X account/app/selection is refused even after revoke; changed selection is a distinct ungranted source', async () => {
  const setup = h.tempVault(), o = await owner(setup); await runXApiConnect(o.io, options, () => {}, o.create, o.open);
  const { db, store } = ledger(setup);
  try {
    const source = listConnections(db)[0]!; const before = store.read(source)!; grant(db, source.source_key);
    for (const revoked of [false, true]) {
      if (revoked) revokeSourceGrant(db, { source_key: source.source_key, expected_revision: 1, operation_id: 'synthetic-x-duplicate-revoke' });
      const duplicate = await owner(setup, o.f);
      await expect(runXApiConnect(duplicate.io, { ...options, newSource: true }, () => {}, duplicate.create, duplicate.open)).rejects.toThrow('source_already_enrolled');
      expect(listConnections(db)).toHaveLength(1); expect(store.read(source)).toEqual(before);
    }
    const distinct = await owner(setup, o.f);
    expect(await runXApiConnect(distinct.io, { ...options, fields: 'links', newSource: true }, () => {}, distinct.create, distinct.open)).toBe(0);
    expect(listConnections(db)).toHaveLength(2);
    const newSource = listConnections(db).find(row => row.source_key !== source.source_key)!;
    expect(inspectSourceGrant(db, newSource.source_key)).toBeNull(); expect(getCheckpoint(db, ID, newSource.source_key)).toBeNull();
  } finally { db.close(); }
});

test('concurrent native X enrollments exclude the loser before browser and provider callbacks', async () => {
  const setup = h.tempVault(), a = await owner(setup), b = await owner(setup);
  const result = await Promise.allSettled([a, b].map(o => runXApiConnect(o.io, { ...options, newSource: true }, () => {}, o.create, o.open)));
  expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  const rejected = result.find(item => item.status === 'rejected') as PromiseRejectedResult;
  expect(String(rejected.reason)).toContain('X sign-in did not complete');
  const loser = [a, b][result.findIndex(item => item.status === 'rejected')]!;
  expect(loser.opens()).toBe(0); expect(loser.f.forms).toHaveLength(0); expect(loser.f.requests).toHaveLength(0);
  expect(a.opens() + b.opens()).toBe(1); expect(a.f.forms.length + b.f.forms.length).toBe(1);
  const { db } = ledger(setup); try { expect(listConnections(db)).toHaveLength(1); } finally { db.close(); }
});

test('occupied registered callback refuses before browser, provider and connection publication', async () => {
  const setup = h.tempVault(), o = await owner(setup), server = Bun.serve({ hostname: '127.0.0.1', port: Number(new URL(o.redirect).port), fetch: () => new Response() });
  try {
    await expect(runXApiConnect(o.io, options, () => {}, o.create, o.open)).rejects.toThrow('sign-in did not complete');
    expect(o.opens()).toBe(0); expect(o.f.forms).toEqual([]); expect(o.f.requests).toEqual([]);
    const { db } = ledger(setup); try { expect(listConnections(db)).toEqual([]); } finally { db.close(); }
  } finally { await server.stop(true); }
});

for (const fault of ['browser', 'state', 'provider', 'account', 'publication'] as const) test(`X ${fault} failure preserves the existing source and closes its listener`, async () => {
  const setup = h.tempVault(), o = await owner(setup); await runXApiConnect(o.io, options, () => {}, o.create, o.open);
  const { db, store } = ledger(setup);
  const before = listConnections(db)[0]!, bytes = store.read(before)!;
  const retry = await owner(setup, o.f);
  if (fault === 'account') retry.f.before = async () => Response.json({ data: { id: '8' } });
  if (fault === 'provider') retry.f.beforeToken = async () => ({ status: 500, body: { detail: 'SYNTHETIC_PRIVATE_PROVIDER_ERROR' } });
  if (fault === 'publication') db.exec("CREATE TRIGGER synthetic_x_publication_failure BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_PRIVATE_PUBLICATION_ERROR'); END");
  try {
    await expect(runXApiConnect(retry.io, { ...options, source: before.source_key }, () => {}, retry.create, async raw => {
      if (fault === 'browser') throw Error('SYNTHETIC_PRIVATE_BROWSER_ERROR');
      if (fault === 'state') { const callback = new URL(retry.redirect); callback.searchParams.set('code', 'synthetic-code'); callback.searchParams.set('state', 'wrong-state'); await fetch(callback); }
      else await retry.open(raw);
    })).rejects.toThrow('sign-in did not complete');
    expect(store.read(listConnections(db)[0]!)).toEqual(bytes); expect(listConnections(db)[0]!.source_key).toBe(before.source_key);
    expect(retry.output.join('\n')).not.toContain('SYNTHETIC_PRIVATE'); await expect(fetch(retry.redirect)).rejects.toThrow();
    expect(readdirSync(join(setup.vault, '.kizuki/connections')).filter(name => name.endsWith('.state'))).toHaveLength(1);
  } finally { if (fault === 'publication') db.exec('DROP TRIGGER synthetic_x_publication_failure'); db.close(); }
});

test('reauthorization refuses changed selection and ignores environment overrides of v2 public configuration', async () => {
  const setup = h.tempVault(), o = await owner(setup); await runXApiConnect(o.io, options, () => {}, o.create, o.open);
  const retry = await owner(setup, o.f);
  await expect(runXApiConnect(retry.io, { ...options, fields: 'links' }, () => {}, retry.create, retry.open)).rejects.toThrow('preserve');
  expect(retry.opens()).toBe(0);
  retry.io.env.KIZUKI_X_CLIENT_ID = 'different-public-app';
  retry.io.env.KIZUKI_X_REDIRECT_URI = 'http://127.0.0.1:9/callback';
  expect(await runXApiConnect(retry.io, options, () => {}, retry.create, retry.open)).toBe(0);
  expect(retry.auth().searchParams.get('client_id')).toBe(o.f.clientId);
});

test('public X CLI and catalog distinguish native configuration, explicit selection and separate account qualification', async () => {
  const setup = h.tempVault(), o = await owner(setup);
  const missing = h.runCli({ ...setup.env, KIZUKI_X_CLIENT_ID: '' }, '--vault', setup.vault, 'connect', 'x-api', '--fields', 'none', '--history-start', historyStart, '--json');
  expect(missing.exitCode).not.toBe(0); expect(missing.stderr).toContain('X native app is not configured'); expect(missing.stdout).toBe('');
  const ambiguous = h.runCli(setup.env, 'connect', 'x-api', '--source', 'synthetic', '--new-source');
  expect(ambiguous.exitCode).toBe(2); expect(ambiguous.stderr).toContain('mutually exclusive');
  for (const args of [['gmail', '--history-start', historyStart], ['x-api', '--calendar', 'private'], ['x-api', '--token-ref', 'env:SYNTHETIC']]) {
    const invalid = h.runCli(setup.env, 'connect', ...args); expect(invalid.exitCode).toBe(2);
  }
  expect(xApiSelection('media,relationships', historyStart).fields).toEqual(['relationships', 'media']);
  expect(xApiRequiredFields(xApiSelection('none', historyStart))).toEqual(['text', 'subjects', 'metadata']);
  expect(xApiRequiredFields(xApiSelection('links', historyStart))).toEqual(['text', 'subjects', 'metadata']);
  expect(xApiRequiredFields(xApiSelection('media,relationships', historyStart))).toEqual(['text', 'subjects', 'metadata', 'attachments']);
  for (const raw of [undefined, '', 'text', 'links,links', 'none,links']) expect(() => xApiSelection(raw, historyStart)).toThrow('explicit');
  expect(() => xApiSelection('text', historyStart)).toThrow('author identity');
  expect(() => xApiSelection('none', '2026-01-01T00:00:00.0001Z')).toThrow();
  for (const callback of ['http://localhost:1234/callback', 'http://127.0.0.1:0/callback', o.redirect + '?x=1']) expect(() => xApiClient({ ...o.io.env, KIZUKI_X_REDIRECT_URI: callback })).toThrow('not configured');
  printConnectorCatalog(o.io, true);
  const catalog = JSON.parse(o.output.at(-1)!); const x = catalog.data.sources.find((row: { id: string }) => row.id === ID);
  expect(x).toMatchObject({ available: true, cli_enrollable: true, mode: 'native account sign-in' }); expect(x.detail).toContain('real-account qualification pending');
});

test('actual process interruption during native X sign-in leaves the original source recoverable and releases the socket', async () => {
  const setup = h.tempVault(), o = await owner(setup); await runXApiConnect(o.io, options, () => {}, o.create, o.open);
  const { db, store } = ledger(setup);
  const source = listConnections(db)[0]!, before = store.read(source)!;
  const redirect = o.redirect, script = join(setup.root, 'interrupted-x.ts');
  writeFileSync(script, `import { runXApiConnect } from ${JSON.stringify(join(import.meta.dir, '../src/commands/connect-x-api.ts'))};
import { createXApiConnector } from ${JSON.stringify(join(import.meta.dir, '../../connector-x/src/api/connector.ts'))};
import { XApiFixture } from ${JSON.stringify(join(import.meta.dir, '../../connector-x/src/api/testkit.ts'))};
const f = new XApiFixture(1);
const io = { env: ${JSON.stringify({ ...o.io.env, KIZUKI_X_REDIRECT_URI: redirect })}, vaultOverride: ${JSON.stringify(setup.vault)}, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true, out: () => {}, err: () => {}, prompt: async () => { throw Error('unexpected prompt'); } };
await runXApiConnect(io, ${JSON.stringify({ ...options, source: source.source_key })}, () => {}, (config, deps) => createXApiConnector(config, { ...deps, fetch: f.fetch, now: f.now, oauth: { ...deps.oauth, postForm: async () => { throw Error('no provider before callback'); } } }), async () => { process.stdout.write(${JSON.stringify('listener-ready\n')}); await new Promise(() => {}); });`);
  const child = Bun.spawn([process.execPath, script], { cwd: process.cwd(), env: process.env, stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = child.stdout.getReader();
    const ready = await withDeadline(reader.read(), 4000, 'synthetic child listener deadline');
    expect(new TextDecoder().decode(ready.value)).toBe('listener-ready\n'); reader.releaseLock();
    child.kill('SIGKILL'); await withDeadline(child.exited, 3000, 'synthetic child exit deadline');
    expect(store.recover(db).unresolved).toEqual([]);
    expect(listConnections(db)).toHaveLength(1); expect(store.read(listConnections(db)[0]!)).toEqual(before);
    await expect(fetch(redirect)).rejects.toThrow();
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } db.close(); }
});
