import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHelpers } from './helpers';
import { createAppHost } from '../src/app/host';
import type { CliIo } from '../src/commands';
const h = createHelpers();
afterEach(h.cleanup);
const policy = { purposes: ['capture', 'recall', 'session'], allowed_fields: ['text', 'subjects', 'metadata', 'attachments'], retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private' };
test('native local app enrolls folder, requires consent, captures and queries without a writer daemon', async () => {
    const setup = h.tempVault(), notes = join(setup.vault, '..', 'synthetic-notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'one.md'), '# Synthetic\n\nThe synthetic memory sentinel is chartreuse.');
    const io: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: () => { }, err: () => { }, prompt: async () => { throw Error('no prompt'); } };
    const host = createAppHost(io);
    async function call(route: string, body: unknown = {}) { const response = await host.handle(new Request('http://127.0.0.1/app/v1/' + route, { method: 'POST', body: JSON.stringify(body) })); return response.json() as Promise<any>; }
    async function done(id: string) { for (let i = 0; i < 200; i++) {
        const value = await call('operation', { id });
        if (value.data.state !== 'running')
            return value.data;
        await Bun.sleep(10);
    } throw Error('synthetic job did not finish'); }
    try {
        expect((await call('status')).data.vault.ready).toBe(true);
        const enrolled = await done((await call('enroll', { provider: 'markdown', path: notes })).data.operation_id);
        expect(enrolled.state).toBe('succeeded');
        const source = enrolled.result.source_key;
        const denied = await done((await call('capture', { source_key: source, mode: 'backfill' })).data.operation_id);
        expect(denied.state).toBe('failed');
        expect((await call('consent', { source_key: source, expected_revision: 0, operation_id: 'synthetic-app-grant', policy })).ok).toBe(true);
        const capture = await done((await call('capture', { source_key: source, mode: 'backfill' })).data.operation_id);
        expect(capture.state).toBe('succeeded');
        expect(capture.counts.stored).toBe(1);
        const query = await call('query', { text: 'chartreuse' });
        expect(query.ok).toBe(true);
        expect(query.data.hits.some((hit: any) => hit.text.includes('chartreuse'))).toBe(true);
        expect((await call('query', { text: 'chartreuse', unknown: 'refuse' })).ok).toBe(false);
        const epoch = (await call('status')).data.visibility_epoch;
        expect((await done((await call('revoke', { source_key: source, expected_revision: 1, operation_id: 'synthetic-app-revoke' })).data.operation_id)).state).toBe('succeeded');
        expect((await call('status')).data.visibility_epoch).not.toBe(epoch);
        expect((await call('query', { text: 'chartreuse' })).data.hits).toHaveLength(0);
        const sources = (await call('sources')).data.sources;
        expect(sources[0].consent).toBe('denied');
        expect(sources[0].revoke_operation).toBe('synthetic-app-revoke');
        const erased = await done((await call('resume_revocation', { source_key: source, operation_id: 'synthetic-app-revoke' })).data.operation_id);
        expect(erased.state).toBe('succeeded');
        expect(erased.result.message).toContain('erasure');
        expect((await call('operation', { id: 'unknown' })).data.state).toBe('unknown');
    }
    finally {
        await host.close();
    }
});
import { startApp } from '../src/commands/app';
import { appAssets } from '../src/app/assets';
test('app launcher embeds offline assets and never prints its session capability', async () => {
    const setup = h.tempVault(), output: string[] = [];
    let launched = '';
    const io: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: line => output.push(line), err: line => output.push(line), prompt: async () => { throw Error(); } };
    const app = await startApp(io, { noService: true }, async (url) => { launched = url; });
    try {
        const token = new URL(launched).hash.slice('#token='.length);
        expect(token).toHaveLength(43);
        expect(output.join('')).not.toContain(token);
        for (const [path, asset] of Object.entries(appAssets)) {
            const response = await fetch(app.url + path);
            expect(response.status).toBe(200);
            expect(typeof asset.body).toBe('string');
            expect(await response.text()).toBe(asset.body);
        }
        const response = await fetch(app.url + '/app/v1/status', { method: 'POST', headers: { origin: app.url, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{}' });
        expect(response.status).toBe(200);
        expect((await response.json() as any).data.setup_no_service).toBe(true);
    }
    finally {
        await app.close();
    }
});
test('first setup uses the visible default path without a supported supervisor and refuses unmarked adoption', async () => {
    const env = h.isolatedEnv(), io: CliIo = { env, vaultOverride: null, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: () => { }, err: () => { }, prompt: async () => { throw Error(); } }, host = createAppHost(io);
    const call = async (route: string, body: unknown = {}) => (await host.handle(new Request('http://127.0.0.1/app/v1/' + route, { method: 'POST', body: JSON.stringify(body) }))).json() as Promise<any>;
    try {
        const state = (await call('status')).data;
        expect(state.vault.ready).toBe(false);
        expect(state.setup_location).toBe(join(env.HOME!, 'Kizuki'));
        const start = await call('initialize');
        let result;
        for (let i = 0; i < 100; i++) {
            result = (await call('operation', { id: start.data.operation_id })).data;
            if (result.state !== 'running')
                break;
            await Bun.sleep(10);
        }
        expect(result.state).toBe('succeeded');
        expect((await call('status')).data.vault.ready).toBe(true);
        expect((await call('initialize')).ok).toBe(true); // Refusal is an operation result, never a second init.
    }
    finally {
        await host.close();
    }
    const folder = h.tempDir();
    writeFileSync(join(folder, 'keep.txt'), 'synthetic-owner-file');
    const separate = createAppHost({ ...io, vaultOverride: folder });
    try {
        const start = await separate.handle(new Request('http://127.0.0.1/app/v1/initialize', { method: 'POST', body: '{}' }));
        const id = (await start.json() as any).data.operation_id;
        await Bun.sleep(50);
        const result = await separate.handle(new Request('http://127.0.0.1/app/v1/operation', { method: 'POST', body: JSON.stringify({ id }) }));
        expect((await result.json() as any).data.state).toBe('failed');
    }
    finally {
        await separate.close();
    }
});
test('missing Google application config refuses before injected provider and browser capabilities', async () => {
    const setup = h.tempVault();
    let calls = 0;
    const io: CliIo = { env: { ...setup.env, KIZUKI_GMAIL_CLIENT_ID: '' }, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: () => { }, err: () => { }, prompt: async () => { calls++; throw Error(); } };
    const host = createAppHost(io, { gmail: () => { calls++; throw Error(); }, openGoogleUrl: async () => { calls++; } });
    try {
        const response = await host.handle(new Request('http://127.0.0.1/app/v1/enroll', { method: 'POST', body: JSON.stringify({ provider: 'gmail', fields: ['text'] }) }));
        const id = (await response.json() as any).data.operation_id;
        await Bun.sleep(20);
        const result = await host.handle(new Request('http://127.0.0.1/app/v1/operation', { method: 'POST', body: JSON.stringify({ id }) }));
        expect((await result.json() as any).data.state).toBe('failed');
        expect(calls).toBe(0);
    }
    finally {
        await host.close();
    }
});
import { createGmailConnector, GMAIL_SCOPES } from '@kizuki/connector-gmail';
import { GmailFixture } from '../../connector-gmail/src/testing';
import type { OAuthTransport } from '@kizuki/core';
test('browser owner enrollment uses native SignInIo with false TTY flags and returns only safe identity projection', async () => {
    const setup = h.tempVault(), f = new GmailFixture(0);
    let reply!: (url: URL) => void;
    const callback = new Promise<URL>(resolve => { reply = resolve; });
    let opens = 0;
    const oauth: OAuthTransport = { listen: async () => ({ redirect_uri: 'http://127.0.0.1:39123/callback', callback: () => callback, close: async () => { } }), postForm: async () => ({ status: 200, body: { access_token: 'synthetic-app-oauth-access', refresh_token: 'synthetic-app-oauth-refresh', expires_in: 3600, scope: GMAIL_SCOPES.join(' '), token_type: 'Bearer' } }) };
    const io: CliIo = { env: { ...setup.env, KIZUKI_GMAIL_CLIENT_ID: 'synthetic' }, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: () => { }, err: () => { }, prompt: async () => { throw Error('no terminal'); } };
    const host = createAppHost(io, { gmail: (config, deps) => createGmailConnector(config, { ...deps, fetch: f.fetch, now: f.now, oauth }), openGoogleUrl: async (raw) => { opens++; const url = new URL(raw); expect(url.origin).toBe('https://accounts.google.com'); const result = new URL('http://127.0.0.1:39123/callback'); result.searchParams.set('state', url.searchParams.get('state')!); result.searchParams.set('code', 'synthetic-code'); reply(result); } });
    const call = async (route: string, body: unknown = {}) => (await host.handle(new Request('http://127.0.0.1/app/v1/' + route, { method: 'POST', body: JSON.stringify(body) }))).json() as Promise<any>;
    try {
        const start = await call('enroll', { provider: 'gmail', fields: ['text'] });
        let done;
        for (let i = 0; i < 200; i++) {
            done = (await call('operation', { id: start.data.operation_id })).data;
            if (done.state !== 'running')
                break;
            await Bun.sleep(10);
        }
        expect(done.state).toBe('succeeded');
        expect(opens).toBe(1);
        const sources = await call('sources');
        expect(sources.data.sources[0].consent).toBe('required');
        expect(sources.data.sources[0].required_fields).toContain('text');
        expect(sources.data.sources[0].required_fields).not.toContain('attachments');
        expect(JSON.stringify(sources)).not.toContain('synthetic-app-oauth');
    }
    finally {
        await host.close();
    }
});
import { accept, applyCanonWrite, createBudgetTracker, insertClaim, openLedger, resolveTarget } from '@kizuki/core';
import { existsSync } from 'node:fs';
test('app activity and undo route through the existing native receipted writer', async () => {
    const setup = h.tempVault(), db = openLedger(join(setup.vault, '.kizuki/kizuki.db'));
    let receipt: string, page: string;
    try {
        const event = accept(db, { schema: 'kizuki.event/v1', connector_id: 'synthetic', source_record_id: 'app-audit-fixture', kind: 'message', occurred_at: '2026-01-01T00:00:00Z', observed_at: '2026-01-01T00:00:00Z', text: 'Synthetic works at SyntheticCo.', subjects: [{ subject_id: 'person:synthetic', role: 'about', display_name: 'Synthetic' }], sensitivity_hint: 'private', deleted: false, attachments: [], metadata: {} });
        if (event.status !== 'stored')
            throw Error('fixture refused');
        const result = await insertClaim({ db }, { kind: 'claim', target: 'people/synthetic', subject: 'person:synthetic', predicate: 'employment.works_at', object: 'syntheticco', polarity: 'positive', body: 'Synthetic works at SyntheticCo.', frontmatter: { type: 'person', title: 'Synthetic' }, provenance: [event.event.event_id], subjects: ['person:synthetic'], producer: 'deterministic', confidence: 0.8, sensitivity: 'private', taint: 'clean', events: [{ event_id: event.event.event_id, connector_id: 'synthetic', taint: 'untrusted', text: 'Synthetic works at SyntheticCo.' }] });
        if (result.outcome !== 'stored')
            throw Error('fixture claim refused');
        const io = { db, vault_path: setup.vault };
        const written = applyCanonWrite(io, result.claim, resolveTarget(io, result.claim), { writer: 'loop', budget: createBudgetTracker({ canon_writes_per_run: 2 }) });
        receipt = written.receipt_id;
        page = written.page_path;
    }
    finally {
        db.close();
    }
    const host = createAppHost({ env: setup.env, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: () => { }, err: () => { }, prompt: async () => { throw Error(); } });
    const call = async (route: string, body: unknown = {}) => (await host.handle(new Request('http://127.0.0.1/app/v1/' + route, { method: 'POST', body: JSON.stringify(body) }))).json() as Promise<any>;
    try {
        expect((await call('activity')).data.receipts.some((row: any) => row.id === receipt)).toBe(true);
        const start = await call('undo', { receipt_id: receipt });
        let done;
        for (let i = 0; i < 100; i++) {
            done = (await call('operation', { id: start.data.operation_id })).data;
            if (done.state !== 'running')
                break;
            await Bun.sleep(10);
        }
        expect(done.state).toBe('succeeded');
        expect(existsSync(join(setup.vault, page))).toBe(false);
        expect((await call('activity')).data.receipts.some((row: any) => row.id === receipt && row.reverted)).toBe(true);
    }
    finally {
        await host.close();
    }
});
