import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClaim, inspectSourceGrant, setSourceGrant, readWorldView, OWNER } from '@kizuki/core';
import { openLedger } from '@kizuki/core/testing';
import { worldFixture } from '../../core/test/serving/world-fixture';
import { applyCanonWrite } from '../../core/src/canon/apply';
import { budget } from '../../core/test/canon/helpers';
import { worldCanonPath, worldClaimHandle } from '../../core/src/canon/world-materialization';
import { startApp } from '../src/commands/app';
import type { CliIo } from '../src/commands';
import { createHelpers } from './helpers';

const h = createHelpers();
afterEach(h.cleanup);

async function fixture() {
    const setup = h.tempVault(), dbPath = join(setup.vault, '.kizuki', 'kizuki.db');
    const db = openLedger(dbPath);
    const world = await worldFixture(db);
    const path = worldCanonPath(worldClaimHandle(db, world.claims[0]!)!);
    applyCanonWrite({ db, vault_path: setup.vault }, world.claims.map(id => getClaim(db, id)!),
        { action: 'create', rel_path: path }, { writer: 'loop', budget: budget() });
    const pageId = db.query<{ page_id: string }, [string]>('SELECT page_id FROM page_index WHERE rel_path=?').get(path)!.page_id;
    db.close();
    const io: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out() {}, err() {}, prompt: async () => '' };
    let token = '';
    const app = await startApp(io, { noService: true }, async url => { token = new URL(url).hash.slice('#token='.length); });
    async function request(route: string, body: unknown = {}) {
        const response = await fetch(app.url + '/app/v1/' + route, { method: 'POST',
            headers: { origin: app.url, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return response.json() as Promise<any>;
    }
    async function done(id: string) {
        for (let attempt = 0; attempt < 200; attempt++) {
            const response = await request('operation', { id });
            if (response.data.state !== 'running') return response.data;
            await Bun.sleep(10);
        }
        throw new Error('App correction did not finish');
    }
    const nativeEvents = () => {
        const current = openLedger(dbPath);
        try { return current.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE connector_id='kizuki.owner'").get()!.n; }
        finally { current.close(); }
    };
    return { ...setup, dbPath, world, path, pageId, request, done, nativeEvents, close: app.close };
}

test('authenticated App corrects a typed writer page and undoes the actual rewrite', async () => {
    const f = await fixture();
    try {
        const before = readFileSync(join(f.vault, f.path), 'utf8');
        const targets = await f.request('correction_targets', { page_id: f.pageId });
        expect(targets.ok).toBe(true);
        const target = targets.data.claims.find((claim: any) => claim.predicate === 'concept.definition');
        expect(target.body).toContain('Revise beliefs using evidence');
        expect(target.target.world_claim.kind).toBe('claim');
        expect(target).not.toHaveProperty('claim_id');
        const unsupported = targets.data.claims.find((claim: any) => claim.predicate === 'world.kind');
        expect(unsupported.target).toBeNull();
        expect(unsupported.unsupported_reason).toBe('unsupported_assertion');
        const args = { target: target.target, statement: 'Use prior odds and the likelihood ratio.' };
        const preview = await f.request('correction_preview', args);
        expect(preview.ok).toBe(true);
        expect(preview.data.affected_pages).toBe(1);
        expect(f.nativeEvents()).toBe(0);
        const applied = await f.done((await f.request('correct', args)).data.operation_id);
        expect(applied.state).toBe('succeeded');
        expect(applied.result.rewritten_pages).toBe(1);
        expect(f.nativeEvents()).toBe(1);
        expect(readFileSync(join(f.vault, f.path), 'utf8')).toContain(args.statement);
        expect(readFileSync(join(f.vault, f.path), 'utf8')).not.toContain('Revise beliefs using evidence');
        expect((await f.request('correction_preview', args)).ok).toBe(false);
        const stale = await f.done((await f.request('correct', args)).data.operation_id);
        expect(stale.state).toBe('failed');
        expect(f.nativeEvents()).toBe(1);
        const undone = await f.done((await f.request('undo', { receipt_id: applied.result.receipt_id })).data.operation_id);
        expect(undone.state).toBe('succeeded');
        expect(readFileSync(join(f.vault, f.path), 'utf8')).toBe(before);
    } finally { await f.close(); }
});

test('correction-purpose withdrawal hides typed targets and refuses stale preview and write before native evidence', async () => {
    const f = await fixture();
    try {
        const target = (await f.request('correction_targets', { page_id: f.pageId })).data.claims.find((claim: any) => claim.predicate === 'concept.definition');
        expect(target.target).toBeDefined();
        const db = openLedger(f.dbPath);
        try {
            const grant = inspectSourceGrant(db, f.world.sourceKey);
            if (grant === null) throw new Error('fixture grant missing');
            setSourceGrant(db, { source_key: f.world.sourceKey, expected_revision: grant.revision, operation_id: 'withdraw-app-correction',
                policy: { ...grant.policy!, purposes: grant.policy!.purposes.filter(purpose => purpose !== 'correction') } });
        } finally { db.close(); }
        expect((await f.request('correction_targets', { page_id: f.pageId })).data.claims).toEqual([]);
        const args = { target: target.target, statement: 'A replacement that must not be filed.' };
        expect((await f.request('correction_preview', args)).ok).toBe(false);
        expect((await f.done((await f.request('correct', args)).data.operation_id)).state).toBe('failed');
        expect(f.nativeEvents()).toBe(0);
    } finally { await f.close(); }
});

test('App correction target union rejects mixed, malformed and extra fields before operations', async () => {
    const f = await fixture();
    try {
        const target = (await f.request('correction_targets', { page_id: f.pageId })).data.claims.find((claim: any) => claim.predicate === 'concept.definition');
        expect(target.target).toBeDefined();
        for (const input of [
            { target: target.target, claim_id: f.world.claims[2] },
            { target: { ...target.target, claim_id: f.world.claims[2] } },
            { target: { world_claim: { ...target.target.world_claim, extra: true } } },
            { target: { world_claim: { kind: 'object', token: target.target.world_claim.token } } },
            { target: { world_claim: { kind: 'claim', token: 'invalid' } } },
        ]) {
            const result = await f.request('correct', { ...input, statement: 'A replacement.' });
            expect(result).toEqual({ ok: false, error: { code: 'invalid_request', retryable: false } });
        }
        expect(f.nativeEvents()).toBe(0);
    } finally { await f.close(); }
});

test('valid opaque references to unsupported assertions and unknown references cannot append native corrections', async () => {
    const f = await fixture();
    try {
        const db = openLedger(f.dbPath);
        let classification: { kind: 'claim'; token: string };
        try {
            const world = readWorldView({ db, vaultPath: f.vault, principal: OWNER }, {
                operation: 'concept', concept: f.world.ref, valid: { kind: 'all' }, knownAt: { kind: 'current' },
            });
            if ('status' in world || world.result.status === 'unavailable' || !('concept' in world.result.data)) throw new Error('fixture concept unavailable');
            classification = world.result.data.concept.classificationClaims[0]!;
        } finally { db.close(); }
        for (const ref of [classification, { kind: 'claim', token: 'z'.repeat(43) }]) {
            const input = { target: { world_claim: ref }, statement: 'A replacement that must not be filed.' };
            expect((await f.request('correction_preview', input)).ok).toBe(false);
            expect((await f.done((await f.request('correct', input)).data.operation_id)).state).toBe('failed');
        }
        expect(f.nativeEvents()).toBe(0);
    } finally { await f.close(); }
});
