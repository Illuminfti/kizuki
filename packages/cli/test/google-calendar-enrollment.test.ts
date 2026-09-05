import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHelpers } from './helpers';
const h = createHelpers();
afterEach(h.cleanup);
test('public GoogleCalendar command refuses missing operator app configuration before interaction', () => {
    const setup = h.tempVault();
    const result = h.runCli({ ...setup.env, KIZUKI_GOOGLE_CALENDAR_CLIENT_ID: '' }, '--vault', setup.vault, 'connect', 'google-calendar', '--calendar', 'fixture-calendar', '--fields', 'summary', '--json');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('Google Calendar desktop client is not configured');
});
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionStateStore, getCheckpoint, listConnections, openLedger, revokeSourceGrant, runToCompletion, setSourceGrant, type OAuthTransport } from '@kizuki/core';
import { createGoogleCalendarConnector, inspectGoogleCalendarState, GOOGLE_CALENDAR_SCOPES, type GoogleCalendarConnectorConfig, type GoogleCalendarConnectorDeps } from '@kizuki/connector-google-calendar';
import { CalendarFixture } from '../../connector-google-calendar/src/testing';
import { runGoogleCalendarConnect } from '../src/commands/connect-google-calendar';
import { listHostConnections, loadConnector, selectConnection } from '../src/connections';
import type { CliIo } from '../src/commands';
function ownerIo(setup: ReturnType<typeof h.tempVault>) { const output: string[] = []; let prompts = 0; const io: CliIo = { env: { ...setup.env, KIZUKI_GOOGLE_CALENDAR_CLIENT_ID: 'synthetic-client', KIZUKI_GOOGLE_CALENDAR_CLIENT_SECRET_REF: 'env:SYNTHETIC_APP_SECRET', SYNTHETIC_APP_SECRET: 'synthetic-app-secret' }, vaultOverride: setup.vault, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true, out: line => output.push(line), err: line => output.push(line), prompt: async () => { prompts++; throw Error('no prompts'); } }; return { io, output, prompts: () => prompts }; }
function oauth(f: CalendarFixture) { let reply!: (url: URL) => void, opens = 0, posts = 0; const callback = new Promise<URL>(resolve => { reply = resolve; }); const transport: OAuthTransport = { listen: async () => ({ redirect_uri: 'http://127.0.0.1:39123/callback', callback: () => callback, close: async () => { } }), postForm: async () => { posts++; return { status: 200, body: { access_token: 'synthetic-oauth-access', refresh_token: 'synthetic-oauth-refresh', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.join(' '), token_type: 'Bearer' } }; } }; return { create: (config: GoogleCalendarConnectorConfig, deps: GoogleCalendarConnectorDeps) => createGoogleCalendarConnector(config, { ...deps, oauth: transport, fetch: f.fetch, now: f.now }), open: async (raw: string) => { opens++; const url = new URL(raw); expect(url.origin).toBe('https://accounts.google.com'); expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(url.searchParams.get('scope')).toBe(GOOGLE_CALENDAR_SCOPES.join(' ')); const result = new URL('http://127.0.0.1:39123/callback'); result.searchParams.set('state', url.searchParams.get('state')!); result.searchParams.set('code', 'synthetic-code'); reply(result); }, counts: () => ({ opens, posts }) }; }
const fields = 'summary,description,location,attendees,attachments';
function grant(db: ReturnType<typeof openLedger>, source: string, allowed_fields: ('text' | 'subjects' | 'attachments' | 'metadata')[] = ['text', 'subjects', 'attachments', 'metadata']) { setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: 'synthetic-google-calendar-grant', policy: { purposes: ['capture'], allowed_fields, retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private' } }); }
test('native GoogleCalendar enrollment, grant-first load, pending reauth and edited/deleted history survive restart', async () => {
    const setup = h.tempVault(), owner = ownerIo(setup), f = new CalendarFixture(), sign = oauth(f);
    f.rows=Array.from({length:21},(_,i)=>({...f.rows[0],id:`event${i}`}));
    expect(await runGoogleCalendarConnect(owner.io, { calendar: 'fixture-calendar', fields, json: true }, () => { }, sign.create, sign.open)).toBe(0);
    expect(sign.counts()).toEqual({ opens: 1, posts: 1 });
    expect(owner.prompts()).toBe(0);
    expect(owner.output.join('\n')).toContain('consent-required');
    const path = join(setup.vault, '.kizuki/kizuki.db');
    let db = openLedger(path), store = new ConnectionStateStore(join(setup.vault, '.kizuki'));
    try {
        const source = listConnections(db)[0]!;
        expect(inspectGoogleCalendarState(store.read(source)!).account_id).toBe(f.account);
        expect(statSync(join(setup.vault, '.kizuki', source.secret_refs[0]!.slice(5))).mode & 0o777).toBe(0o600);
        for (const secret of ['synthetic-oauth-access', 'synthetic-oauth-refresh', 'synthetic-app-secret']) {
            expect(owner.output.join('\n')).not.toContain(secret);
            for (const suffix of ["", "-wal", "-shm"])
                if (existsSync(path + suffix))
                    expect(readFileSync(path + suffix).includes(Buffer.from(secret))).toBe(false);
        }
        let factories = 0;
        const load = () => loadConnector(selectConnection(db, store, 'kizuki.google-calendar', source.source_key), store, db, owner.io.env, (_id, config, deps) => { factories++; return createGoogleCalendarConnector(config as GoogleCalendarConnectorConfig, { ...deps, fetch: f.fetch, now: f.now }); });
        const before = f.calls.length;
        await expect(load()).rejects.toThrow('source_capture_denied');
        expect(factories).toBe(0);
        expect(f.calls.length).toBe(before);
        grant(db, source.source_key);
        const initial = await load();
        expect((await runToCompletion(db, initial, 'kizuki.google-calendar', source.source_key, 'backfill', { maxBatches: 1 })).stored).toBe(20);
        await initial.revoke();
        db.close();
        db = openLedger(path);
        store = new ConnectionStateStore(join(setup.vault, '.kizuki'));
        const checkpoint = getCheckpoint(db, 'kizuki.google-calendar', source.source_key)!.cursor;
        const oldState = store.read(listConnections(db)[0]!)!;
        expect(inspectGoogleCalendarState(oldState).has_pending).toBe(true);
        const again = oauth(f);
        expect(await runGoogleCalendarConnect(ownerIo(setup).io, { calendar: 'fixture-calendar', fields, json: true, source: source.source_key }, () => { }, again.create, again.open)).toBe(0);
        expect(getCheckpoint(db, 'kizuki.google-calendar', source.source_key)!.cursor).toBe(checkpoint);
        expect(listConnections(db)[0]!.source_key).toBe(source.source_key);
        const resumed = await load();
        const rest = await runToCompletion(db, resumed, 'kizuki.google-calendar', source.source_key, 'backfill');
        expect(rest.errors).toEqual([]);
        expect(rest.stored).toBe(1);
        await resumed.revoke();
        f.rows=[{...f.rows[0],summary:'Edited synthetic calendar',updated:'2024-01-04T00:00:00Z'},{id:'event1',status:'cancelled'}]; f.version++;
        const synced = await load();
        const update = await runToCompletion(db, synced, 'kizuki.google-calendar', source.source_key, 'sync');
        expect(update.errors).toEqual([]);
        expect(update.stored).toBe(2);
        await synced.revoke();
        const replay = await load();
        expect((await runToCompletion(db, replay, 'kizuki.google-calendar', source.source_key, 'sync')).stored).toBe(0);
        await replay.revoke();
        const prior = store.read(listConnections(db)[0]!)!, priorCursor = getCheckpoint(db, 'kizuki.google-calendar', source.source_key)!.cursor;
        f.account = 'different-synthetic-account';
        const other = oauth(f);
        await expect(runGoogleCalendarConnect(ownerIo(setup).io, { calendar: 'fixture-calendar', fields, json: true, source: source.source_key }, () => { }, other.create, other.open)).rejects.toThrow('identity');
        expect(store.read(listConnections(db)[0]!)).toEqual(prior);
        expect(getCheckpoint(db, 'kizuki.google-calendar', source.source_key)!.cursor).toBe(priorCursor);
        revokeSourceGrant(db, { source_key: source.source_key, expected_revision: 1, operation_id: 'synthetic-google-calendar-revoke' });
        const calls = f.calls.length;
        await expect(load()).rejects.toThrow('source_capture_denied');
        expect(f.calls.length).toBe(calls);
    }
    finally {
        db.close();
    }
});
test('field-incompatible grant refuses before app secret resolution or factory and cannot silently change reauth fields', async () => {
    const setup = h.tempVault(), owner = ownerIo(setup), f = new CalendarFixture(), sign = oauth(f);
    await runGoogleCalendarConnect(owner.io, { calendar: 'fixture-calendar', fields, json: true }, () => { }, sign.create, sign.open);
    const db = openLedger(join(setup.vault, '.kizuki/kizuki.db')), store = new ConnectionStateStore(join(setup.vault, '.kizuki'));
    try {
        const source = listConnections(db)[0]!;
        grant(db, source.source_key, ['metadata']);
        let factories = 0;
        const badEnv = { KIZUKI_GOOGLE_CALENDAR_CLIENT_ID: 'synthetic', KIZUKI_GOOGLE_CALENDAR_CLIENT_SECRET_REF: 'file:/nonexistent-synthetic-secret' };
        await expect(loadConnector(selectConnection(db, store, 'kizuki.google-calendar', source.source_key), store, db, badEnv, () => { factories++; throw Error('unexpected'); })).rejects.toThrow('source_field_denied');
        expect(factories).toBe(0);
        const state = store.read(source)!;
        const again = oauth(f);
        await expect(runGoogleCalendarConnect(ownerIo(setup).io, { calendar: 'fixture-calendar', fields: 'summary', json: true, source: source.source_key }, () => { }, again.create, again.open)).rejects.toThrow('preserve');
        expect(again.counts()).toEqual({ opens: 0, posts: 0 });
        expect(store.read(source)!).toEqual(state);
    }
    finally {
        db.close();
    }
});
test('missing app configuration invokes no injected browser, factory or prompt', async () => {
    const setup = h.tempVault(), owner = ownerIo(setup);
    delete owner.io.env.KIZUKI_GOOGLE_CALENDAR_CLIENT_ID;
    let calls = 0;
    await expect(runGoogleCalendarConnect(owner.io, { calendar: 'fixture-calendar', fields, json: true }, () => { }, () => { calls++; throw Error('unexpected'); }, async () => { calls++; })).rejects.toThrow('not configured');
    expect(calls).toBe(0);
    expect(owner.prompts()).toBe(0);
});


test('denied GoogleCalendar selection and enumeration never open protected state before capture admission', async () => {
    const setup = h.tempVault(), owner = ownerIo(setup), f = new CalendarFixture(), sign = oauth(f);
    await runGoogleCalendarConnect(owner.io, { calendar: 'fixture-calendar', fields, json: true }, () => {}, sign.create, sign.open);
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
            const requests = f.calls.length;
            const read = spyOn(store, 'read');
            try {
                const selected = selectConnection(db, store, 'kizuki.google-calendar', source.source_key);
                await expect(loadConnector(selected, store, db, owner.io.env, () => { factories++; throw Error('unexpected factory'); })).rejects.toThrow('source_capture_denied');
                const enumerated = listHostConnections(db, store).find(item => item.connection.source_key === source.source_key)!;
                await expect(loadConnector(enumerated, store, db, owner.io.env, () => { factories++; throw Error('unexpected factory'); })).rejects.toThrow('source_capture_denied');
                expect(read).not.toHaveBeenCalled();
                expect(factories).toBe(0);
                expect(f.calls.length).toBe(requests);
            } finally { read.mockRestore(); }
        }
    } finally { db.close(); }
});

test('Calendar public state inspector is nonsecret and replacement binds page, anchors and cooldown',async()=>{
 const {assertSameGoogleCalendarIdentity}=await import('@kizuki/connector-google-calendar');const {parseState,encodeState,digest}=await import('../../connector-google-calendar/src/state');
 const f=new CalendarFixture();await(await f.connected()).backfill(null);const state=parseState(f.state);state.anchors[digest('synthetic-anchor')]='2024-01-03T00:00:00Z';state.retry_not_before='2024-01-04T00:00:00Z';const before=encodeState(state);
 expect(JSON.stringify(inspectGoogleCalendarState(before))).not.toContain('synthetic-access');expect(inspectGoogleCalendarState(before).calendar_id).toBe(f.calendar);
 for(const kind of ['account','calendar','fields','pending','anchors','cooldown'] as const){const changed=parseState(before);if(kind==='account')changed.oauth.account.id='other-synthetic';if(kind==='calendar')changed.calendar='other-calendar';if(kind==='fields')changed.fields=[];if(kind==='pending')changed.pending=null;if(kind==='anchors')changed.anchors={};if(kind==='cooldown')changed.retry_not_before=null;expect(()=>assertSameGoogleCalendarIdentity(before,encodeState(changed))).toThrow();}
 const rotated=parseState(before);rotated.oauth.tokens.access_token='synthetic-rotation';expect(()=>assertSameGoogleCalendarIdentity(before,encodeState(rotated))).not.toThrow();
});

test('Calendar canonical calendar and none selection are explicit before browser or appsecret',async()=>{
 const {googleCalendarFields,googleCalendarRequiredFields}=await import('../src/google-calendar');expect(googleCalendarFields('none')).toEqual([]);expect(googleCalendarRequiredFields([])).toEqual(['metadata','subjects']);
 const setup=h.tempVault(),owner=ownerIo(setup);let calls=0;owner.io.env.KIZUKI_GOOGLE_CALENDAR_CLIENT_SECRET_REF='file:/nonexistent-synthetic-secret';
 await expect(runGoogleCalendarConnect(owner.io,{calendar:'primary',fields:'none',json:true},()=>{},()=>{calls++;throw Error('unexpected')},async()=>{calls++;})).rejects.toThrow('primary alias');expect(calls).toBe(0);
});

test('public catalogue reports Calendar desktop configuration gate without resolving secrets',()=>{
 const setup=h.tempVault();for(const configured of [false,true]){const result=h.runCli({...setup.env,KIZUKI_GOOGLE_CALENDAR_CLIENT_ID:configured?'synthetic':'',KIZUKI_GOOGLE_CALENDAR_CLIENT_SECRET_REF:'file:/nonexistent-synthetic-secret'},'connect','--list','--json');expect(result.exitCode).toBe(0);const entry=JSON.parse(result.stdout).data.sources.find((item:{id:string})=>item.id==='kizuki.google-calendar');expect(entry.cli_enrollable).toBe(true);expect(entry.available).toBe(configured);expect(entry.mode).toContain('sign-in');expect(entry.detail).toContain('calendar');}
});

test('cancelled Calendar reauthorization preserves source consent and opaque state',async()=>{
 const setup=h.tempVault(),owner=ownerIo(setup),f=new CalendarFixture(),sign=oauth(f);await runGoogleCalendarConnect(owner.io,{calendar:f.calendar,fields,json:true},()=>{},sign.create,sign.open);
 const db=openLedger(join(setup.vault,'.kizuki/kizuki.db')),store=new ConnectionStateStore(join(setup.vault,'.kizuki'));try{const connection=listConnections(db)[0]!;grant(db,connection.source_key);revokeSourceGrant(db,{source_key:connection.source_key,expected_revision:1,operation_id:'synthetic-cancel-revoked'});const before=store.read(connection)!;
 const cancelled=oauth(f);await expect(runGoogleCalendarConnect(ownerIo(setup).io,{calendar:f.calendar,fields,source:connection.source_key,json:true},()=>{},(config,deps)=>createGoogleCalendarConnector(config,{...deps,fetch:f.fetch,now:f.now,oauth:{listen:async()=>{throw Error('synthetic cancelled')},postForm:async()=>{throw Error('unexpected')}}}),cancelled.open)).rejects.toThrow('sign-in');expect(store.read(connection)).toEqual(before);expect(cancelled.counts()).toEqual({opens:0,posts:0});
 const {inspectSourceGrant}=await import('@kizuki/core');expect(inspectSourceGrant(db,connection.source_key)!.status).toBe('denied');
 }finally{db.close();}
});

test('explicit new Calendar source distinguishes account/calendar but ignores fields for duplicate identity',async()=>{
 const setup=h.tempVault(),owner=ownerIo(setup);
 async function enroll(account:string,calendar:string,chosen=fields){const f=new CalendarFixture();f.account=account;f.calendar=calendar;const sign=oauth(f);return runGoogleCalendarConnect(owner.io,{calendar,fields:chosen,newSource:true,json:true},()=>{},sign.create,sign.open);}
 expect(await enroll('synthetic-A','calendar-one')).toBe(0);
 await expect(enroll('synthetic-A','calendar-one','none')).rejects.toThrow('source');
 expect(await enroll('synthetic-A','calendar-two')).toBe(0);expect(await enroll('synthetic-B','calendar-one')).toBe(0);
 const db=openLedger(join(setup.vault,'.kizuki/kizuki.db')),store=new ConnectionStateStore(join(setup.vault,'.kizuki'));
 try{const all=listConnections(db);expect(all).toHaveLength(3);expect(new Set(all.map(item=>item.source_key)).size).toBe(3);for(const item of all){expect(getCheckpoint(db,'kizuki.google-calendar',item.source_key)).toBeNull();expect(statSync(join(store.directory,`${item.source_key}.state`)).mode&0o777).toBe(0o600);}}
 finally{db.close();}
});
