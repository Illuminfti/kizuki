import { afterEach, expect, test } from 'bun:test';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectSourceGrant, listCanonReceipts, listRunReceipts, type SourceGrantPolicy } from '@kizuki/core';
import { openLedger } from '@kizuki/core/testing';
import { startApp } from '../src/commands/app';
import type { CliIo } from '../src/commands';
import { createHelpers } from './helpers';
import { defaultChatCompletion, startFakeEndpoint, type SeenRequest } from '../../llm/test/fake-endpoint';

const h = createHelpers();
afterEach(h.cleanup);
const KEY = 'synthetic-app-model-key';
const PRIVATE_RESPONSE = 'synthetic-provider-private-diagnostic';
const policy: SourceGrantPolicy = {
    purposes: ['capture', 'recall', 'session', 'correction', 'audit', 'derive', 'extract', 'export'],
    allowed_fields: ['text', 'subjects', 'metadata'],
    retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private',
};
function completion(request: SeenRequest): Response {
    const body = request.body as { model: string; messages: { content: string }[] };
    const prompt = body.messages.map(message => message.content).join('\n');
    const eventId = /record ([A-Za-z0-9:_.-]+) from/.exec(prompt)?.[1];
    if (!eventId) return defaultChatCompletion('Synthetic connection works.');
    const subjectJson = /"subject":"((?:\\.|[^"\\])*)"/.exec(prompt)?.[1];
    if (!subjectJson) throw Error('synthetic subject missing');
    return defaultChatCompletion(JSON.stringify({ claims: [{
        kind: 'claim', subject: JSON.parse(`"${subjectJson}"`), predicate: 'employment.role',
        object: 'orchard library collaborator', polarity: 'positive', body: 'Ada contributes to the orchard library.',
        valid_from: null, valid_to: null, confidence: 0.7, sensitivity: 'private', event_ids: [eventId],
    }] }));
}

test('authenticated first use separates connection tests, source permission and receipted model processing', async () => {
    const env = h.isolatedEnv(), notes = h.tempDir('app-model-notes-'), outputs: string[] = [], visible: unknown[] = [];
    const vault = join(env.HOME!, 'Kizuki');
    writeFileSync(join(notes, 'ada.md'), 'Ada joined the orchard library project.');
    const endpoint = startFakeEndpoint(completion), replacement = startFakeEndpoint(completion);
    const io: CliIo = { env, vaultOverride: null, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
        out: line => outputs.push(line), err: line => outputs.push(line), prompt: async () => { throw Error('no coaching prompt'); } };
    let token = '';
    const launch = async (url: string) => { token = new URL(url).hash.slice('#token='.length); };
    let app = await startApp(io, { noService: true }, launch);
    async function call(route: string, body: unknown = {}) {
        const response = await fetch(app.url + '/app/v1/' + route, { method: 'POST',
            headers: { origin: app.url, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json() as any; visible.push(result); return result;
    }
    async function done(id: string) {
        for (let i = 0; i < 500; i++) {
            const result = (await call('operation', { id })).data;
            if (result.state !== 'running') return result;
            await Bun.sleep(10);
        }
        throw Error('app model operation deadline');
    }
    const run = async () => done((await call('run_pass')).data.operation_id);
    try {
        expect((await call('status')).data.vault.ready).toBe(false);
        expect((await done((await call('initialize')).data.operation_id)).state).toBe('succeeded');
        const empty = (await call('model_status')).data;
        expect(empty.selection).toEqual({ kind: 'none' });
        const selection = { kind: 'openai_compatible', base_url: endpoint.base_url, model: 'synthetic-app-model' };
        const saved = (await call('model_save', { expected_revision: empty.revision, selection, credential: { action: 'replace', value: KEY } })).data;
        expect(saved.credential).toBe('configured');
        expect(saved.selection.model_endpoint).toBe(endpoint.base_url + '/chat/completions');
        expect(endpoint.requests).toHaveLength(0);
        expect((await call('model_save', { expected_revision: empty.revision, selection, credential: { action: 'keep' } })).error.code).toBe('revision_conflict');
        expect((await done((await call('model_test', { expected_revision: saved.revision })).data.operation_id)).state).toBe('succeeded');
        expect(endpoint.requests).toHaveLength(1);
        expect(JSON.stringify(endpoint.requests[0]!.body)).not.toContain('orchard');
        expect(endpoint.requests[0]!.headers.authorization).toBe('Bearer ' + KEY);
        expect((await call('model_status')).data.last_test.outcome).toBe('succeeded');
        const enrolled = await done((await call('enroll', { provider: 'markdown', path: notes })).data.operation_id);
        expect(enrolled.state).toBe('succeeded');
        const source = enrolled.result.source_key;
        expect((await call('source_model_consent', { source_key: source, expected_revision: 0, expected_model_revision: saved.revision, operation_id: 'no-grant', allow: true })).error.code).toBe('source_not_active');
        expect((await call('consent', { source_key: source, expected_revision: 0, operation_id: 'local-app-source', policy })).ok).toBe(true);
        expect((await done((await call('capture', { source_key: source, mode: 'backfill' })).data.operation_id)).state).toBe('succeeded');
        const localOnly = await run();
        expect(localOnly.result.run.model_calls).toBe(0);
        expect(localOnly.result.run.claims_extracted).toBe(0);
        const localDb = openLedger(join(vault, '.kizuki/kizuki.db'));
        try {
            const localClaims = localDb.query('SELECT producer,model_ref,authority,taint FROM claims').all();
            expect(localClaims.length).toBeGreaterThan(0);
            for (const claim of localClaims) expect(claim).toMatchObject({ producer: 'deterministic', model_ref: null, authority: 'connector_evidence', taint: 'quoted' });
        } finally { localDb.close(); }
        expect(endpoint.requests).toHaveLength(1);
        expect((await call('sources')).data.sources[0].model_consent).toBe('local_only');
        const permission = { source_key: source, expected_revision: 1, expected_model_revision: saved.revision, operation_id: 'allow-app-source-model', allow: true };
        expect((await call('source_model_consent', permission)).data.revision).toBe(2);
        expect((await call('source_model_consent', permission)).data.revision).toBe(2);
        const grantDb = openLedger(join(vault, '.kizuki/kizuki.db'));
        try { expect(inspectSourceGrant(grantDb, source)?.policy).toEqual({ ...policy,
            purposes: [...policy.purposes].sort(), allowed_fields: [...policy.allowed_fields].sort(),
            egress: { model_endpoint: endpoint.base_url + '/chat/completions', model: selection.model, external_retention: 'provider_managed' } }); }
        finally { grantDb.close(); }
        expect((await call('sources')).data.sources[0].model_consent).toBe('current');
        const processed = await run();
        expect(processed.state).toBe('succeeded');
        expect(processed.result.run.model_calls).toBe(1);
        expect(processed.result.run.canon_writes).toBeGreaterThan(0);
        expect(endpoint.requests).toHaveLength(2);
        expect(endpoint.requests[1]!.headers.authorization).toBe('Bearer ' + KEY);
        // Runtime processing must retain the same private custody as settings,
        // rather than resolving the generated path through a weaker file reader.
        const config = Bun.TOML.parse(readFileSync(join(vault, '.kizuki/serve.toml'), 'utf8')) as any;
        const credentialPath = config.ports.llm.secret_ref.slice(5);
        for (const path of [credentialPath, join(vault, '.kizuki/app-model')]) {
            chmodSync(path, path === credentialPath ? 0o644 : 0o755);
            try {
                const refused = await run();
                expect(refused.state).toBe('failed');
                expect(refused.result.run.model_calls).toBe(0);
                expect(endpoint.requests).toHaveLength(2);
            } finally { chmodSync(path, path === credentialPath ? 0o600 : 0o700); }
        }
        const db = openLedger(join(vault, '.kizuki/kizuki.db'));
        try {
            const actual = listRunReceipts(db).find(row => row.run_id === processed.result.run.run_id)!;
            expect(actual.canon_writes).toBe(processed.result.run.canon_writes);
            expect(actual.model.calls).toBe(processed.result.run.model_calls);
            expect(listCanonReceipts(db, { limit: 20 }).some(row => row.writer === 'loop')).toBe(true);
        } finally { db.close(); }
        const memory = (await call('query', { text: 'orchard' })).data.hits.find((hit: any) => hit.scope === 'canon');
        expect(memory).toBeDefined();
        expect((await call('activity')).data.receipts.length).toBeGreaterThan(0);
        const targets = (await call('correction_targets', { page_id: memory.id })).data;
        const target = targets.claims.find((claim: any) => claim.object === 'orchard library collaborator');
        expect(target).toBeDefined();
        const correction = { claim_id: target.claim_id, statement: 'Ada is an orchard library coordinator.', object: 'orchard library coordinator' };
        const priorActivity = (await call('activity')).data.receipts.length;
        const preview = await call('correction_preview', correction);
        expect(preview.ok).toBe(true);
        expect(preview.data.affected_pages).toBeGreaterThan(0);
        expect((await call('activity')).data.receipts.length).toBe(priorActivity);
        const corrected = await done((await call('correct', correction)).data.operation_id);
        expect(corrected.state).toBe('succeeded');
        expect(corrected.result.rewritten_pages).toBeGreaterThan(0);
        expect(corrected.result.receipt_id).toBeTruthy();
        expect((await call('query', { text: 'orchard library coordinator' })).data.hits.some((hit: any) => hit.scope === 'canon' && hit.text.includes('coordinator'))).toBe(true);
        expect((await done((await call('undo', { receipt_id: corrected.result.receipt_id })).data.operation_id)).state).toBe('succeeded');
        expect((await call('activity')).data.receipts.find((receipt: any) => receipt.id === corrected.result.receipt_id).reverted).toBe(true);
        expect((await call('query', { text: 'orchard' })).data.hits.find((hit: any) => hit.scope === 'canon' && hit.id === memory.id)?.text).toBe(memory.text);

        const grant = { ceiling: 'public', types: null, subjects: null, since: null, until: null,
            tools: ['search', 'get_page'], rate_limit_per_minute: 60, relay_owner_corrections: false };
        const enrollment = { name: 'reading-assistant', grant, operation_id: 'app-agent-first-use' };
        const agent = await done((await call('agent_enroll', enrollment)).data.operation_id);
        expect(agent.state).toBe('succeeded');
        expect(agent.result.agent.receipt.authority).toBe('active');
        expect(agent.result.agent.receipt.grant).toEqual({ ...grant, tools: ['get_page', 'search'] });
        expect(agent.result.agent.mcp.args).toContain('--token-ref');
        expect(agent.result.agent.mcp.args).not.toContain('--owner');
        expect((await call('agents')).data.agents[0].name).toBe(enrollment.name);
        const repeat = await done((await call('agent_enroll', enrollment)).data.operation_id);
        expect(repeat.result.agent.receipt.replayed).toBe(true);
        expect(repeat.result.agent.mcp).toEqual(agent.result.agent.mcp);
        const revokedAgent = await done((await call('agent_revoke', { name: enrollment.name })).data.operation_id);
        expect(revokedAgent.result.agent.receipt.authority).toBe('revoked');
        expect((await call('agents')).data.agents[0].revoked_at).not.toBeNull();

        const revisedPolicy = { ...policy, allowed_fields: [...policy.allowed_fields, 'attachments'],
            egress: { model_endpoint: endpoint.base_url + '/chat/completions', model: selection.model, external_retention: 'provider_managed' } };
        expect((await call('consent', { source_key: source, expected_revision: 2, operation_id: 'expand-app-source-fields', policy: revisedPolicy })).data.revision).toBe(3);
        expect((await call('source_model_consent', permission)).error.code).toBe('source_revision_conflict');
        const afterReplay = openLedger(join(vault, '.kizuki/kizuki.db'));
        try {
            expect(inspectSourceGrant(afterReplay, source)?.revision).toBe(3);
            expect(inspectSourceGrant(afterReplay, source)?.policy.allowed_fields).toContain('attachments');
        } finally { afterReplay.close(); }

        const changed = (await call('model_save', { expected_revision: saved.revision,
            selection: { ...selection, base_url: replacement.base_url }, credential: { action: 'keep' } })).data;
        expect(changed.last_test).toBeNull();
        expect((await call('sources')).data.sources[0].model_consent).toBe('different_model');
        expect((await call('source_model_consent', { ...permission, expected_revision: 3, operation_id: 'stale-model-revision' })).error.code).toBe('revision_conflict');
        writeFileSync(join(notes, 'later.md'), 'Ada coordinates the orchard library reading group.');
        expect((await run()).result.run.model_calls).toBe(0);
        expect(replacement.requests).toHaveLength(0);
        expect((await call('source_model_consent', { ...permission, expected_revision: 3, expected_model_revision: changed.revision, operation_id: 'allow-replacement-model' })).data.revision).toBe(4);
        expect((await run()).result.run.model_calls).toBeGreaterThan(0);
        expect(replacement.requests.length).toBeGreaterThan(0);

        await app.close();
        app = await startApp(io, { noService: true }, launch);
        const restored = (await call('model_status')).data;
        expect(restored.revision).toBe(changed.revision);
        expect(restored.credential).toBe('configured');
        expect(restored.last_test).toBeNull();
        replacement.reply = () => new Response(PRIVATE_RESPONSE, { status: 401 });
        expect((await done((await call('model_test', { expected_revision: changed.revision })).data.operation_id)).state).toBe('failed');
        expect((await call('model_status')).data.last_test.outcome).toBe('failed');
        const revoked = await done((await call('revoke', { source_key: source, expected_revision: 4, operation_id: 'remove-app-model-source' })).data.operation_id);
        expect(revoked.state).toBe('succeeded');
        const afterSourceRevocation = (await call('query', { text: 'orchard' })).data.hits;
        // The owner's independently entered statement remains quoted evidence.
        // Every imported-source hit and derived canon page must be withheld.
        expect(afterSourceRevocation.map((hit: any) => ({ scope: hit.scope, title: hit.title, text: hit.text })))
            .toEqual([{ scope: 'ledger', title: 'kizuki.owner', text: correction.statement }]);
        expect((await call('correction_targets', { page_id: memory.id })).data.claims).toHaveLength(0);
        expect((await call('correction_preview', correction)).ok).toBe(false);
        expect(readFileSync(join(notes, 'ada.md'), 'utf8')).toContain('orchard');
        const publicBytes = JSON.stringify([visible, outputs, readFileSync(join(vault, '.kizuki/run-receipts.jsonl'), 'utf8')]);
        for (const secret of [KEY, PRIVATE_RESPONSE]) expect(publicBytes).not.toContain(secret);
        expect(JSON.stringify(visible)).not.toContain('secret_ref');
        // Only the expressly requested MCP configuration contains a file ref.
        const withoutAgentSetup = visible.filter((response: any) => !response.data?.result?.agent?.mcp);
        expect(JSON.stringify(withoutAgentSetup)).not.toContain('file:');
    } finally { await app.close(); endpoint.stop(); replacement.stop(); }
}, 30_000);
