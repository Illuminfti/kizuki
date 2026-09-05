import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHelpers } from './helpers';
const h = createHelpers();
afterEach(h.cleanup);
test('public Gmail command refuses missing operator app configuration before interaction', () => {
    const setup = h.tempVault();
    const result = h.runCli({ ...setup.env, KIZUKI_GMAIL_CLIENT_ID: '' }, '--vault', setup.vault, 'connect', 'gmail', '--fields', 'text', '--json');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('Gmail desktop client is not configured');
});
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionStateStore, getCheckpoint, listConnections, openLedger, revokeSourceGrant, runToCompletion, setSourceGrant, type OAuthTransport } from '@kizuki/core';
import { createGmailConnector, inspectGmailState, GMAIL_SCOPES, type GmailConnectorConfig, type GmailConnectorDeps } from '@kizuki/connector-gmail';
import { GmailFixture } from '../../connector-gmail/src/testing';
import { runGmailConnect } from '../src/commands/connect-gmail';
import { listHostConnections, loadConnector, selectConnection } from '../src/connections';
import type { CliIo } from '../src/commands';
function ownerIo(setup: ReturnType<typeof h.tempVault>) { const output: string[] = []; let prompts = 0; const io: CliIo = { env: { ...setup.env, KIZUKI_GMAIL_CLIENT_ID: 'synthetic-client', KIZUKI_GMAIL_CLIENT_SECRET_REF: 'env:SYNTHETIC_APP_SECRET', SYNTHETIC_APP_SECRET: 'synthetic-app-secret' }, vaultOverride: setup.vault, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true, out: line => output.push(line), err: line => output.push(line), prompt: async () => { prompts++; throw Error('no prompts'); } }; return { io, output, prompts: () => prompts }; }
function oauth(f: GmailFixture) { let reply!: (url: URL) => void, opens = 0, posts = 0; const callback = new Promise<URL>(resolve => { reply = resolve; }); const transport: OAuthTransport = { listen: async () => ({ redirect_uri: 'http://127.0.0.1:39123/callback', callback: () => callback, close: async () => { } }), postForm: async () => { posts++; return { status: 200, body: { access_token: 'synthetic-oauth-access', refresh_token: 'synthetic-oauth-refresh', expires_in: 3600, scope: GMAIL_SCOPES.join(' '), token_type: 'Bearer' } }; } }; return { create: (config: GmailConnectorConfig, deps: GmailConnectorDeps) => createGmailConnector(config, { ...deps, oauth: transport, fetch: f.fetch, now: f.now }), open: async (raw: string) => { opens++; const url = new URL(raw); expect(url.origin).toBe('https://accounts.google.com'); expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPES.join(' ')); const result = new URL('http://127.0.0.1:39123/callback'); result.searchParams.set('state', url.searchParams.get('state')!); result.searchParams.set('code', 'synthetic-code'); reply(result); }, counts: () => ({ opens, posts }) }; }
const fields = 'text,subjects,headers,labels,attachments';
function grant(db: ReturnType<typeof openLedger>, source: string, allowed_fields: ('text' | 'subjects' | 'attachments' | 'metadata')[] = ['text', 'subjects', 'attachments', 'metadata']) { setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: 'synthetic-gmail-grant', policy: { purposes: ['capture'], allowed_fields, retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private' } }); }
test('native Gmail enrollment, grant-first load, pending reauth and edited/deleted history survive restart', async () => {
    const setup = h.tempVault(), owner = ownerIo(setup), f = new GmailFixture(21), sign = oauth(f);
    expect(await runGmailConnect(owner.io, { fields, json: true }, () => { }, sign.create, sign.open)).toBe(0);
    expect(sign.counts()).toEqual({ opens: 1, posts: 1 });
    expect(owner.prompts()).toBe(0);
    expect(owner.output.join('\n')).toContain('consent-required');
    const path = join(setup.vault, '.kizuki/kizuki.db');
    let db = openLedger(path), store = new ConnectionStateStore(join(setup.vault, '.kizuki'));
    try {
        const source = listConnections(db)[0]!;
        expect(inspectGmailState(store.read(source)!).account_id).toBe(f.account);
        expect(statSync(join(setup.vault, '.kizuki', source.secret_refs[0]!.slice(5))).mode & 0o777).toBe(0o600);
        for (const secret of ['synthetic-oauth-access', 'synthetic-oauth-refresh', 'synthetic-app-secret']) {
            expect(owner.output.join('\n')).not.toContain(secret);
            for (const suffix of ["", "-wal", "-shm"])
                if (existsSync(path + suffix))
                    expect(readFileSync(path + suffix).includes(Buffer.from(secret))).toBe(false);
        }
        let factories = 0;
        const load = () => loadConnector(selectConnection(db, store, 'kizuki.gmail', source.source_key), store, db, owner.io.env, (_id, config, deps) => { factories++; return createGmailConnector(config as GmailConnectorConfig, { ...deps, fetch: f.fetch, now: f.now }); });
        const before = f.requests.length;
        await expect(load()).rejects.toThrow('source_capture_denied');
        expect(factories).toBe(0);
        expect(f.requests.length).toBe(before);
        grant(db, source.source_key);
        const initial = await load();
        expect((await runToCompletion(db, initial, 'kizuki.gmail', source.source_key, 'backfill', { maxBatches: 1 })).stored).toBe(20);
        await initial.revoke();
        db.close();
        db = openLedger(path);
        store = new ConnectionStateStore(join(setup.vault, '.kizuki'));
        const checkpoint = getCheckpoint(db, 'kizuki.gmail', source.source_key)!.cursor;
        const oldState = store.read(listConnections(db)[0]!)!;
        expect(inspectGmailState(oldState).has_pending).toBe(true);
        const again = oauth(f);
        expect(await runGmailConnect(ownerIo(setup).io, { fields, json: true, source: source.source_key }, () => { }, again.create, again.open)).toBe(0);
        expect(getCheckpoint(db, 'kizuki.gmail', source.source_key)!.cursor).toBe(checkpoint);
        expect(listConnections(db)[0]!.source_key).toBe(source.source_key);
        const resumed = await load();
        const rest = await runToCompletion(db, resumed, 'kizuki.gmail', source.source_key, 'backfill');
        expect(rest.errors).toEqual([]);
        expect(rest.stored).toBe(1);
        await resumed.revoke();
        f.messages.get('m1')!.payload = { mimeType: 'text/plain', body: { data: Buffer.from('Edited synthetic Gmail body').toString('base64url') } };
        f.change('m1', 'labelsAdded');
        f.change('m2', 'messagesDeleted');
        const synced = await load();
        const update = await runToCompletion(db, synced, 'kizuki.gmail', source.source_key, 'sync');
        expect(update.errors).toEqual([]);
        expect(update.stored).toBe(2);
        await synced.revoke();
        const replay = await load();
        expect((await runToCompletion(db, replay, 'kizuki.gmail', source.source_key, 'sync')).stored).toBe(0);
        await replay.revoke();
        const prior = store.read(listConnections(db)[0]!)!, priorCursor = getCheckpoint(db, 'kizuki.gmail', source.source_key)!.cursor;
        f.account = 'different-synthetic-account';
        const other = oauth(f);
        await expect(runGmailConnect(ownerIo(setup).io, { fields, json: true, source: source.source_key }, () => { }, other.create, other.open)).rejects.toThrow('identity');
        expect(store.read(listConnections(db)[0]!)).toEqual(prior);
        expect(getCheckpoint(db, 'kizuki.gmail', source.source_key)!.cursor).toBe(priorCursor);
        revokeSourceGrant(db, { source_key: source.source_key, expected_revision: 1, operation_id: 'synthetic-gmail-revoke' });
        const calls = f.requests.length;
        await expect(load()).rejects.toThrow('source_capture_denied');
        expect(f.requests.length).toBe(calls);
    }
    finally {
        db.close();
    }
});
test('field-incompatible grant refuses before app secret resolution or factory and cannot silently change reauth fields', async () => {
    const setup = h.tempVault(), owner = ownerIo(setup), f = new GmailFixture(1), sign = oauth(f);
    await runGmailConnect(owner.io, { fields, json: true }, () => { }, sign.create, sign.open);
    const db = openLedger(join(setup.vault, '.kizuki/kizuki.db')), store = new ConnectionStateStore(join(setup.vault, '.kizuki'));
    try {
        const source = listConnections(db)[0]!;
        grant(db, source.source_key, ['metadata']);
        let factories = 0;
        const badEnv = { KIZUKI_GMAIL_CLIENT_ID: 'synthetic', KIZUKI_GMAIL_CLIENT_SECRET_REF: 'file:/nonexistent-synthetic-secret' };
        await expect(loadConnector(selectConnection(db, store, 'kizuki.gmail', source.source_key), store, db, badEnv, () => { factories++; throw Error('unexpected'); })).rejects.toThrow('source_field_denied');
        expect(factories).toBe(0);
        const state = store.read(source)!;
        const again = oauth(f);
        await expect(runGmailConnect(ownerIo(setup).io, { fields: 'text', json: true, source: source.source_key }, () => { }, again.create, again.open)).rejects.toThrow('preserve');
        expect(again.counts()).toEqual({ opens: 0, posts: 0 });
        expect(store.read(source)!).toEqual(state);
    }
    finally {
        db.close();
    }
});
test('missing app configuration invokes no injected browser, factory or prompt', async () => {
    const setup = h.tempVault(), owner = ownerIo(setup);
    delete owner.io.env.KIZUKI_GMAIL_CLIENT_ID;
    let calls = 0;
    await expect(runGmailConnect(owner.io, { fields, json: true }, () => { }, () => { calls++; throw Error('unexpected'); }, async () => { calls++; })).rejects.toThrow('not configured');
    expect(calls).toBe(0);
    expect(owner.prompts()).toBe(0);
});


test('denied Gmail selection and enumeration never open protected state before capture admission', async () => {
    const setup = h.tempVault(), owner = ownerIo(setup), f = new GmailFixture(1), sign = oauth(f);
    await runGmailConnect(owner.io, { fields, json: true }, () => {}, sign.create, sign.open);
    const db = openLedger(join(setup.vault, '.kizuki/kizuki.db'));
    const store = new ConnectionStateStore(join(setup.vault, '.kizuki'));
    try {
        const source = listConnections(db)[0]!;
        for (const revoked of [false, true]) {
            if (revoked) {
                grant(db, source.source_key);
                revokeSourceGrant(db, {source_key: source.source_key, expected_revision: 1, operation_id: 'synthetic-state-read-revoke'});
            }
            let factories = 0;
            const requests = f.requests.length;
            const read = spyOn(store, 'read');
            try {
                const selected = selectConnection(db, store, 'kizuki.gmail', source.source_key);
                await expect(loadConnector(selected, store, db, owner.io.env, () => { factories++; throw Error('unexpected factory'); })).rejects.toThrow('source_capture_denied');
                const enumerated = listHostConnections(db, store).find(item => item.connection.source_key === source.source_key)!;
                await expect(loadConnector(enumerated, store, db, owner.io.env, () => { factories++; throw Error('unexpected factory'); })).rejects.toThrow('source_capture_denied');
                expect(read).not.toHaveBeenCalled();
                expect(factories).toBe(0);
                expect(f.requests.length).toBe(requests);
            } finally { read.mockRestore(); }
        }
    } finally { db.close(); }
});
