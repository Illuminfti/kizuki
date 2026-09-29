import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { listConnections, signInWithBrowser, type LoopbackListener, type OAuthProvider, type OAuthTransport } from '@kizuki/core';
import { openLedger } from '@kizuki/core/testing';
import { join } from 'node:path';
import { createGmailConnector, GMAIL_SCOPES, type GmailConnectorConfig, type GmailConnectorDeps } from '@kizuki/connector-gmail';
import { GmailFixture } from '../../connector-gmail/src/testing';
import { createGoogleCalendarConnector, GOOGLE_CALENDAR_SCOPES, type GoogleCalendarConnectorConfig, type GoogleCalendarConnectorDeps } from '@kizuki/connector-google-calendar';
import { CalendarFixture } from '../../connector-google-calendar/src/testing';
import { runGoogleCalendarConnect } from '../src/commands/connect-google-calendar';
import type { CliIo } from '../src/commands';
import { runGmailConnect } from '../src/commands/connect-gmail';
import { headlessBrowserOpener } from '../src/headless-sign-in';
import { createHelpers } from './helpers';

setDefaultTimeout(30_000);
const h = createHelpers();
afterEach(h.cleanup);

const REDIRECT = 'http://127.0.0.1:39123/callback';
const AUTH_URL = `https://accounts.google.com/o/oauth2/v2/auth?state=synthetic&redirect_uri=${encodeURIComponent(REDIRECT)}`;

function terminal(env: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  const io: CliIo = { env, vaultOverride: null, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true, out: line => lines.push(line), err: line => lines.push(line), prompt: async () => { throw Error('no prompts'); } };
  return { io, lines, text: () => lines.join('\n') };
}

test('a failing opener prints the authorization URL, the loopback port and an ssh tunnel hint', async () => {
  const t = terminal();
  await headlessBrowserOpener(t.io, async () => { throw Error('no display'); })(AUTH_URL);
  expect(t.text()).toContain(AUTH_URL);
  expect(t.text()).toContain('ssh -L 39123:127.0.0.1:39123 <host>');
  expect(t.text()).not.toContain('no display');
});

test('a working opener prints nothing; --no-browser never calls the opener', async () => {
  const quiet = terminal();
  await headlessBrowserOpener(quiet.io, async () => { })(AUTH_URL);
  expect(quiet.lines).toEqual([]);
  const t = terminal();
  let calls = 0;
  await headlessBrowserOpener(t.io, async () => { calls++; }, true)(AUTH_URL);
  expect(calls).toBe(0);
  expect(t.text()).toContain(AUTH_URL);
  expect(t.text()).toContain('ssh -L 39123:127.0.0.1:39123 <host>');
});

test('the fallback refuses to print a URL that is not plain https', async () => {
  const t = terminal();
  for (const raw of ['http://accounts.google.com/auth', 'https://user:pass@accounts.google.com/auth', 'not a url'])
    await expect(headlessBrowserOpener(t.io, async () => { throw Error('x'); })(raw)).rejects.toThrow();
  expect(t.lines).toEqual([]);
});

function listener(): LoopbackListener & { closed: boolean; deliver(url: URL): void } {
  let deliver!: (url: URL) => void, fail!: (error: Error) => void;
  const pending = new Promise<URL>((resolve, reject) => { deliver = resolve; fail = reject; });
  void pending.catch(() => undefined);
  const value = { redirect_uri: REDIRECT, closed: false, callback: () => pending, deliver, close: async () => { value.closed = true; fail(Error('closed')); } };
  return value;
}
const provider: OAuthProvider = { name: 'Synthetic', authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth', token_url: 'https://oauth2.googleapis.com/token', client_id: 'synthetic-client', scopes: ['read'] };

test('a headless sign-in that is never completed times out cleanly and releases the listener', async () => {
  const t = terminal(), l = listener();
  const transport: OAuthTransport = { listen: async () => l, postForm: async () => { throw Error('token endpoint must not be reached'); } };
  const io = { prompt: async () => '', notify: () => { }, openUrl: headlessBrowserOpener(t.io, async () => { throw Error('no display'); }) };
  await expect(signInWithBrowser(provider, io, transport, { timeoutMs: 40 })).rejects.toThrow();
  expect(l.closed).toBe(true);
  expect(t.text()).toContain('ssh -L 39123:127.0.0.1:39123 <host>');
});

function gmailOwner(setup: ReturnType<typeof h.tempVault>) {
  const t = terminal({ ...setup.env, KIZUKI_GMAIL_CLIENT_ID: 'synthetic-client', KIZUKI_GMAIL_CLIENT_SECRET_REF: 'env:SYNTHETIC_APP_SECRET', SYNTHETIC_APP_SECRET: 'synthetic-app-secret' });
  t.io.vaultOverride = setup.vault;
  return t;
}
function gmailTransport(f: GmailFixture, l: ReturnType<typeof listener>) {
  const transport: OAuthTransport = { listen: async () => l, postForm: async () => ({ status: 200, body: { access_token: 'synthetic-oauth-access', refresh_token: 'synthetic-oauth-refresh', expires_in: 3600, scope: GMAIL_SCOPES.join(' '), token_type: 'Bearer' } }) };
  return (config: GmailConnectorConfig, deps: GmailConnectorDeps) => createGmailConnector(config, { ...deps, oauth: transport, fetch: f.fetch, now: f.now });
}
// The owner finishes sign-in from the printed address, as a browser on another machine would.
function finishFromPrinted(t: ReturnType<typeof terminal>, l: ReturnType<typeof listener>): void {
  const printed = t.text().split('\n').map(line => line.trim()).find(line => line.startsWith('https://accounts.google.com/'));
  expect(printed).toBeDefined();
  const back = new URL(REDIRECT);
  back.searchParams.set('state', new URL(printed!).searchParams.get('state')!);
  back.searchParams.set('code', 'synthetic-code');
  l.deliver(back);
}

test('Gmail sign-in with a failing system opener prints the URL, keeps waiting and completes from the callback', async () => {
  const setup = h.tempVault(), t = gmailOwner(setup), l = listener(), f = new GmailFixture(3);
  const flow = runGmailConnect(t.io, { fields: 'text', json: true }, () => { }, gmailTransport(f, l), async () => { throw Error('SYNTHETIC_OPENER_DIAGNOSTIC'); });
  for (let i = 0; i < 200 && !t.text().includes('ssh -L'); i++) await Bun.sleep(10);
  expect(t.text()).toContain('ssh -L 39123:127.0.0.1:39123 <host>');
  expect(t.text()).not.toContain('SYNTHETIC_OPENER_DIAGNOSTIC');
  finishFromPrinted(t, l);
  expect(await flow).toBe(0);
  const db = openLedger(join(setup.vault, '.kizuki/kizuki.db'));
  try { expect(listConnections(db)).toHaveLength(1); } finally { db.close(); }
});

test('Gmail --no-browser never invokes the system opener', async () => {
  const setup = h.tempVault(), t = gmailOwner(setup), l = listener(), f = new GmailFixture(3);
  let opens = 0;
  const flow = runGmailConnect(t.io, { fields: 'text', json: true, noBrowser: true }, () => { }, gmailTransport(f, l), async () => { opens++; });
  for (let i = 0; i < 200 && !t.text().includes('ssh -L'); i++) await Bun.sleep(10);
  finishFromPrinted(t, l);
  expect(await flow).toBe(0);
  expect(opens).toBe(0);
});

test('Google Calendar --no-browser prints the address and tunnel hint without invoking the opener', async () => {
  const setup = h.tempVault(), l = listener(), f = new CalendarFixture();
  const t = terminal({ ...setup.env, KIZUKI_GOOGLE_CALENDAR_CLIENT_ID: 'synthetic-client', KIZUKI_GOOGLE_CALENDAR_CLIENT_SECRET_REF: 'env:SYNTHETIC_APP_SECRET', SYNTHETIC_APP_SECRET: 'synthetic-app-secret' });
  t.io.vaultOverride = setup.vault;
  const transport: OAuthTransport = { listen: async () => l, postForm: async () => ({ status: 200, body: { access_token: 'synthetic-oauth-access', refresh_token: 'synthetic-oauth-refresh', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.join(' '), token_type: 'Bearer' } }) };
  const create = (config: GoogleCalendarConnectorConfig, deps: GoogleCalendarConnectorDeps) => createGoogleCalendarConnector(config, { ...deps, oauth: transport, fetch: f.fetch, now: f.now });
  let opens = 0;
  const flow = runGoogleCalendarConnect(t.io, { calendar: 'fixture-calendar', fields: 'summary', json: true, noBrowser: true }, () => { }, create, async () => { opens++; });
  for (let i = 0; i < 200 && !t.text().includes('ssh -L'); i++) await Bun.sleep(10);
  expect(t.text()).toContain('ssh -L 39123:127.0.0.1:39123 <host>');
  finishFromPrinted(t, l);
  expect(await flow).toBe(0);
  expect(opens).toBe(0);
});
