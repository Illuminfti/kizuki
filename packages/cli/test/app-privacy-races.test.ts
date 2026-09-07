import { afterEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectSourceGrant, listCanonReceipts, listRunReceipts, withDeadline, type SourceGrantPolicy } from '@kizuki/core';
import { openLedger } from '@kizuki/core/testing';
import { startApp } from '../src/commands/app';
import type { CliIo } from '../src/commands';
import type { AppOperation, AppProtocol, AppRoute } from '../src/app/protocol';
import { createHelpers } from './helpers';
import { traceSyntheticAppFailures } from './app-native-diagnostics';
import { defaultChatCompletion, startFakeEndpoint, type SeenRequest } from '../../llm/test/fake-endpoint';

const h = createHelpers(), cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanup.splice(0)) await close(); } finally { h.cleanup(); } });
const KEY = 'synthetic-private-race-key';
const SOURCE_TEXT = 'Ada coordinates the moonlit orchard project.';
const MODEL_OBJECT = 'orchard keeper';
const policy: SourceGrantPolicy = {
    purposes: ['capture', 'recall', 'session', 'correction', 'audit', 'derive', 'extract', 'export'],
    allowed_fields: ['text', 'subjects', 'metadata'], retention: 'persistent_owned_until_revoked',
    egress: 'local_only', sensitivity_floor: 'private',
};

function completion(request: SeenRequest): Response {
    const body = request.body as { messages: { content: string }[] };
    const prompt = body.messages.map(message => message.content).join('\n');
    const event = /record ([A-Za-z0-9:_.-]+) from/.exec(prompt)?.[1];
    const subject = /"subject":"((?:\\.|[^"\\])*)"/.exec(prompt)?.[1];
    if (!event || !subject) throw Error('synthetic extraction request is missing its bound evidence');
    return defaultChatCompletion(JSON.stringify({ claims: [{
        kind: 'claim', subject: JSON.parse(`"${subject}"`), predicate: 'employment.role',
        object: MODEL_OBJECT, polarity: 'positive', body: SOURCE_TEXT,
        valid_from: null, valid_to: null, confidence: 0.7, sensitivity: 'private', event_ids: [event],
    }] }));
}

/** Every setup action crosses the authenticated HTTP boundary; the database is
 * opened only to compare the published receipt and authorization evidence. */
async function fixture() {
    const env = h.isolatedEnv(), notes = h.tempDir('privacy-race-notes-'), vault = join(env.HOME!, 'Kizuki');
    const diagnostic = traceSyntheticAppFailures(vault);
    cleanup.push(async () => { diagnostic.close(); });
    writeFileSync(join(notes, 'ada.md'), SOURCE_TEXT);
    const endpoint = startFakeEndpoint(completion), output: string[] = [];
    let app: Awaited<ReturnType<typeof startApp>> | undefined, bearer = '';
    cleanup.push(async () => { try { await app?.close(); } finally { endpoint.stop(); } });
    const io: CliIo = { env, vaultOverride: null, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
        out: text => output.push(text), err: text => output.push(text), prompt: async () => { throw Error('unexpected prompt'); } };
    app = await startApp(io, { noService: true }, async url => { bearer = new URL(url).hash.slice('#token='.length); });
    async function call<R extends AppRoute>(route: R, body: AppProtocol[R]['request']): Promise<AppProtocol[R]['response']> {
        const response = await fetch(app!.url + '/app/v1/' + route, { method: 'POST',
            headers: { origin: app!.url, authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json() as { ok: true; data: AppProtocol[R]['response'] } | { ok: false; error: { code: string } };
        if (!result.ok) {
            if (route === 'source_model_consent') diagnostic.report('privacy-fixture-source-model-consent');
            throw Error(result.error.code);
        }
        return result.data;
    }
    async function done(id: string): Promise<AppOperation> {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const job = await call('operation', { id });
            if (job.state !== 'running') return job;
            await Bun.sleep(10);
        }
        throw Error('app privacy operation did not settle');
    }
    function ledger<T>(read: (db: Database) => T): T {
        const db = openLedger(join(vault, '.kizuki/kizuki.db'));
        try { return read(db); } finally { db.close(); }
    }
    expect((await done((await call('initialize', {})).operation_id)).state).toBe('succeeded');
    const empty = await call('model_status', {});
    const model = await call('model_save', { expected_revision: empty.revision,
        selection: { kind: 'openai_compatible', base_url: endpoint.base_url, model: 'synthetic-privacy-model' },
        credential: { action: 'replace', value: KEY } });
    const enrolled = await done((await call('enroll', { provider: 'markdown', path: notes })).operation_id);
    expect(enrolled.state).toBe('succeeded');
    const source = enrolled.result!.source_key!;
    expect((await call('consent', { source_key: source, expected_revision: 0, operation_id: 'privacy-local', policy })).revision).toBe(1);
    expect((await done((await call('capture', { source_key: source, mode: 'backfill' })).operation_id)).state).toBe('succeeded');
    expect((await call('source_model_consent', { source_key: source, expected_revision: 1, expected_model_revision: model.revision,
        operation_id: 'privacy-model', allow: true })).revision).toBe(2);
    const processed = await done((await call('run_pass', {})).operation_id);
    if (processed.state !== 'succeeded') diagnostic.report('privacy-fixture-processing', processed);
    expect(processed.state).toBe('succeeded');
    expect(processed.result!.run!.model_calls).toBe(1);
    expect(processed.result!.run!.canon_writes).toBeGreaterThan(0);
    expect(endpoint.requests).toHaveLength(1);
    const memory = (await call('query', { text: 'orchard' })).hits.find(hit => hit.scope === 'canon')!;
    expect(memory).toBeDefined();
    const target = (await call('correction_targets', { page_id: memory.id })).claims.find(claim => claim.object === MODEL_OBJECT)!;
    expect(target).toBeDefined();
    return { call, done, ledger, notes, vault, output, endpoint, memory, target, source };
}

test('withdrawing only correction purpose preserves recall but refuses owner targets, preview and writes', async () => {
    const f = await fixture(), correction = { claim_id: f.target.claim_id,
        statement: 'PRIVATE_CORRECTION_STATEMENT', object: 'PRIVATE_REPLACEMENT_OBJECT' };
    const current = f.ledger(db => inspectSourceGrant(db, f.source)!.policy);
    const before = f.ledger(db => listCanonReceipts(db, { limit: 100 }).map(receipt => receipt.receipt_id));
    expect((await f.call('consent', { source_key: f.source, expected_revision: 2, operation_id: 'withdraw-correction-only',
        policy: { ...current, purposes: current.purposes.filter(purpose => purpose !== 'correction') } })).revision).toBe(3);
    expect((await f.call('query', { text: 'orchard' })).hits.some(hit => hit.scope === 'canon' && hit.id === f.memory.id)).toBe(true);
    expect((await f.call('correction_targets', { page_id: f.memory.id })).claims).toHaveLength(0);
    await expect(f.call('correction_preview', correction)).rejects.toThrow();
    const refused = await f.done((await f.call('correct', correction)).operation_id);
    expect(refused.state).toBe('failed'); expect(refused.result).toBeNull();
    expect(f.ledger(db => listCanonReceipts(db, { limit: 100 }).map(receipt => receipt.receipt_id))).toEqual(before);
    expect(f.ledger(db => db.query<{ count: number }, []>('SELECT count(*) AS count FROM events WHERE connector_id=\'kizuki.owner\'').get()!.count)).toBe(0);
    const publicJobs = JSON.stringify([(await f.call('status', {})).operations, refused, f.output]);
    for (const privateText of [correction.statement, correction.object, SOURCE_TEXT, MODEL_OBJECT, KEY]) expect(publicJobs).not.toContain(privateText);
    expect(f.endpoint.requests).toHaveLength(1);
}, 15_000);

test('urgent source revocation fences a processing pass while its actual model response is held', async () => {
    const f = await fixture();
    const before = f.ledger(db => listCanonReceipts(db, { limit: 100 }).map(receipt => receipt.receipt_id));
    let arrived!: () => void, release!: () => void;
    const received = new Promise<void>(resolve => { arrived = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    f.endpoint.reply = async request => { arrived(); await hold; return completion(request); };
    writeFileSync(join(f.notes, 'concurrent.md'), 'Ada starts another private orchard project.');
    const pending = (await f.call('run_pass', {})).operation_id;
    try {
        await withDeadline(received, 5000, 'synthetic processing did not reach the model');
        expect((await f.call('operation', { id: pending })).state).toBe('running');
        const revoked = await f.done((await f.call('revoke', { source_key: f.source, expected_revision: 2, operation_id: 'revoke-held-model' })).operation_id);
        expect(revoked.state).toBe('succeeded');
        expect(f.ledger(db => inspectSourceGrant(db, f.source)!.status)).toBe('denied');
        expect((await f.call('operation', { id: pending })).state).toBe('running');
        release();
        const settled = await f.done(pending), projected = settled.result!.run!;
        expect(projected).toMatchObject({ status: 'stopped', canon_writes: 0, claims_extracted: 1, model_calls: 1, model_configured: true });
        const receipt = f.ledger(db => listRunReceipts(db).find(row => row.run_id === projected.run_id)!);
        expect(receipt).toMatchObject({ status: projected.status, canon_writes: projected.canon_writes,
            claims_extracted: projected.claims_extracted, model: { calls: projected.model_calls } });
        expect(f.ledger(db => listCanonReceipts(db, { limit: 100 }).map(receipt => receipt.receipt_id))).toEqual(before);
        expect((await f.call('query', { text: 'orchard' })).hits).toHaveLength(0);
        expect((await f.call('correction_targets', { page_id: f.memory.id })).claims).toHaveLength(0);
        expect(f.endpoint.requests).toHaveLength(2);
        const publicJobs = JSON.stringify([(await f.call('status', {})).operations, settled, revoked, f.output,
            readFileSync(join(f.vault, '.kizuki/run-receipts.jsonl'), 'utf8')]);
        for (const privateText of [SOURCE_TEXT, MODEL_OBJECT, 'Ada', 'orchard', KEY]) expect(publicJobs).not.toContain(privateText);
    } finally { release(); }
}, 15_000);
