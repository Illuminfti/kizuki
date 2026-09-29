import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionStateStore, getCheckpoint, listConnections, runToCompletion, setSourceGrant } from '@kizuki/core';
import { openLedger } from '@kizuki/core/testing';
import { createIcsConnector, type IcsConnectorConfig } from '@kizuki/connectors';
import { FIXTURE_ICS } from '../../connector-ics/src/fixture';
import { okResult } from '../../connector-ics/src/testing/memory-fetch';
import type { IcsFetcher } from '../../connector-ics/src/fetch';
import type { CliIo } from '../src/commands';
import { runIcsUrlConnect } from '../src/commands/connect-ics';
import { listHostConnections, loadConnector, selectConnection } from '../src/connections';
import { createHelpers } from './helpers';

setDefaultTimeout(30_000);
const h = createHelpers();
afterEach(h.cleanup);

const FEED = 'https://calendar.example.test/private/SYNTHETIC-TOKEN/feed.ics';

function owner(setup: ReturnType<typeof h.tempVault>) {
  const lines: string[] = [];
  const io: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: line => lines.push(line), err: line => lines.push(line), prompt: async () => { throw Error('no prompts'); } };
  return { io, text: () => lines.join('\n') };
}
/** A feed that answers 304 to a matching ETag and records what the connector asked for. */
function feed() {
  const asked: { url: string; etag?: string | undefined }[] = [];
  const fetch: IcsFetcher = async (url, conditional) => {
    asked.push({ url, etag: conditional.etag });
    return conditional.etag === '"v1"' ? { status: 304, etag: '"v1"', last_modified: null, text: '' } : okResult(FIXTURE_ICS, '"v1"');
  };
  return { fetch, asked };
}
function ledger(setup: ReturnType<typeof h.tempVault>) {
  return { db: openLedger(join(setup.vault, '.kizuki/kizuki.db')), store: new ConnectionStateStore(join(setup.vault, '.kizuki')) };
}
const policy = { purposes: ['capture' as const], allowed_fields: ['text' as const, 'subjects' as const, 'attachments' as const, 'metadata' as const], retention: 'persistent_owned_until_revoked' as const, egress: 'local_only' as const, sensitivity_floor: 'private' as const };

test('connect ics --url enrolls a private https feed, needs consent, then syncs with ETag validation', async () => {
  const setup = h.tempVault(), o = owner(setup), f = feed();
  expect(await runIcsUrlConnect(o.io, { url: FEED, json: true }, () => { }, { fetch: f.fetch })).toBe(0);
  expect(o.text()).toContain('consent-required');
  expect(o.text()).not.toContain('SYNTHETIC-TOKEN');
  const { db, store } = ledger(setup);
  try {
    const source = listConnections(db)[0]!;
    expect(source.connector_id).toBe('kizuki.ics');
    expect(statSync(join(setup.vault, '.kizuki', source.secret_refs[0]!.slice(5))).mode & 0o777).toBe(0o600);
    expect(new TextDecoder().decode(store.read(source)!)).toContain(FEED);
    for (const suffix of ['', '-wal', '-shm']) { const path = join(setup.vault, '.kizuki/kizuki.db') + suffix; if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from('SYNTHETIC-TOKEN'))).toBe(false); }
    const load = () => loadConnector(selectConnection(db, store, 'kizuki.ics', source.source_key), store, db, o.io.env, (_id, config) => createIcsConnector(config as IcsConnectorConfig, { fetch: f.fetch }));
    await expect(load()).rejects.toThrow('source_capture_denied');
    setSourceGrant(db, { source_key: source.source_key, expected_revision: 0, operation_id: 'synthetic-ics-grant', policy });
    const first = await runToCompletion(db, await load(), 'kizuki.ics', source.source_key, 'backfill');
    expect(first.errors).toEqual([]);
    expect(first.stored).toBeGreaterThan(0);
    expect(getCheckpoint(db, 'kizuki.ics', source.source_key)).not.toBeNull();
    const again = await runToCompletion(db, await load(), 'kizuki.ics', source.source_key, 'sync');
    expect(again.errors).toEqual([]);
    expect(again.stored).toBe(0);
    expect(f.asked.some(call => call.etag === '"v1"')).toBe(true);
  } finally { db.close(); }
});

test('a URL feed is its own source: it never replaces a file calendar and the same URL is not enrolled twice', async () => {
  const setup = h.tempVault(), o = owner(setup), f = feed();
  const file = join(setup.root, 'team.ics');
  writeFileSync(file, FIXTURE_ICS);
  const fileEnrollment = h.runCli(setup.env, '--vault', setup.vault, 'connect', 'ics', '--source', file);
  expect(fileEnrollment.exitCode).toBe(0);
  expect(await runIcsUrlConnect(o.io, { url: FEED, json: true }, () => { }, { fetch: f.fetch })).toBe(0);
  await expect(runIcsUrlConnect(o.io, { url: FEED, json: true }, () => { }, { fetch: f.fetch })).rejects.toThrow('already connected');
  expect(await runIcsUrlConnect(o.io, { url: 'https://calendar.example.test/other.ics', json: true }, () => { }, { fetch: f.fetch })).toBe(0);
  const { db, store } = ledger(setup);
  try {
    expect(listConnections(db)).toHaveLength(3);
    const hosts = listHostConnections(db, store, 'kizuki.ics');
    expect(hosts.filter(item => item.state?.config.path === file)).toHaveLength(1);
    expect(hosts.filter(item => item.state !== null && 'secret_ref' in item.state.config)).toHaveLength(2);
    expect(hosts.every(item => item.problem === null)).toBe(true);
  } finally { db.close(); }
});

test('non-https and malformed feed addresses are refused without echoing them or creating a source', async () => {
  const setup = h.tempVault(), o = owner(setup), f = feed();
  for (const url of ['http://calendar.example.test/SYNTHETIC-TOKEN.ics', 'ftp://calendar.example.test/x.ics', 'not a url']) {
    const error = await runIcsUrlConnect(o.io, { url, json: true }, () => { }, { fetch: f.fetch }).then(() => null, (e: Error) => e);
    expect(error).not.toBeNull();
    expect(error!.message).toContain('https');
    expect(error!.message).not.toContain('SYNTHETIC-TOKEN');
  }
  expect(f.asked).toEqual([]);
  const { db } = ledger(setup);
  try { expect(listConnections(db)).toEqual([]); } finally { db.close(); }
  expect(existsSync(join(setup.vault, '.kizuki/connections')) ? readdirSync(join(setup.vault, '.kizuki/connections')).filter(name => name.endsWith('.state')) : []).toEqual([]);
});

test('public connect ics validates its flags before touching the vault', () => {
  const setup = h.tempVault();
  const run = (...args: string[]) => h.runCli(setup.env, '--vault', setup.vault, 'connect', ...args);
  const http = run('ics', '--url', 'http://calendar.example.test/x.ics', '--json');
  expect(http.exitCode).not.toBe(0);
  expect(http.stderr + http.stdout).toContain('https');
  const both = run('ics', '--url', FEED, '--source', '/tmp/x.ics');
  expect(both.exitCode).not.toBe(0);
  expect(both.stderr + both.stdout).toContain('mutually exclusive');
  const wrong = run('markdown-folder', '--url', FEED);
  expect(wrong.exitCode).not.toBe(0);
  expect(wrong.stderr + wrong.stdout).toContain('--url is only supported for connect ics');
  const browser = run('ics', '--url', FEED, '--no-browser');
  expect(browser.exitCode).not.toBe(0);
  expect(browser.stderr + browser.stdout).toContain('--no-browser is only supported');
});
