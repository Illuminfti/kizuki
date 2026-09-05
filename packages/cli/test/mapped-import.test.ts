import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConnections, openLedger, setSourceGrant } from '@kizuki/core';
import { createHelpers } from './helpers';
const h = createHelpers();
afterEach(h.cleanup);

function source() {
    const setup = h.tempVault(), path = join(setup.root, 'events.jsonl');
    writeFileSync(path, JSON.stringify({ id: 'synthetic-1', text: 'The lapis lantern is in the library.', occurred_at: '2026-01-01T00:00:00Z', observed_at: '2026-01-02T00:00:00Z', subjects: ['ada'] }) + '\n');
    writeFileSync(path + '.kizuki-mapping.json', JSON.stringify({
        schema: 'kizuki.legacy-events-mapping/v1', table: null,
        source_record_id: { column: 'id' }, kind: { const: 'message' }, text: { column: 'text' },
        occurred_at: { column: 'occurred_at', format: 'rfc3339' }, observed_at: { column: 'observed_at', format: 'rfc3339' },
        subjects: [{ column: 'subjects', role: 'about', namespace: 'synthetic', split: null }],
        sensitivity_hint: { const: 'private' }, metadata: { columns: [] },
    }));
    return { ...setup, path };
}

test.each(['connect', 'import'])('mapped legacy events resolve from the explicit source in %s and retain capture consent', command => {
    const setup = source();
    const first = h.runCli(setup.env, command, 'import-legacy-events', '--source', setup.path, '--vault', setup.vault);
    expect(first.stderr).not.toContain('not enrollable');
    const db = openLedger(join(setup.vault, '.kizuki', 'kizuki.db'));
    try {
        const rows = listConnections(db);
        expect(rows).toHaveLength(1);
        // Explicit synthetic grant setup through Core. The public CLI's policy-
        // file path has its own custody suite; this test never relaxes that gate.
        const refused = h.runCli(setup.env, 'import', 'import-legacy-events', '--source', setup.path, '--vault', setup.vault);
        expect(refused.exitCode).not.toBe(0);
        setSourceGrant(db, { source_key: rows[0]!.source_key, expected_revision: 0, operation_id: 'synthetic-mapped-grant', policy: {
            purposes: ['capture', 'recall'], allowed_fields: ['text', 'subjects', 'metadata'], retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private',
        } });
    } finally { db.close(); }
    const imported = h.runCli(setup.env, 'import', 'import-legacy-events', '--source', setup.path, '--vault', setup.vault);
    expect(imported.exitCode).toBe(0);
    const query = h.runCli(setup.env, 'query', 'lapis', '--vault', setup.vault);
    expect(query.exitCode).toBe(0);
    expect(query.stdout).toContain('lapis lantern');
    const replay = h.runCli(setup.env, 'import', 'import-legacy-events', '--source', setup.path, '--vault', setup.vault);
    expect(replay.exitCode).toBe(0);
    expect(replay.stdout).toContain('stored=0');
});

test('missing mapped-source configuration is reported before enrollment', () => {
    const setup = h.tempVault(), path = join(setup.root, 'unmapped.jsonl');
    writeFileSync(path, '{}\n');
    const result = h.runCli(setup.env, 'import', 'import-legacy-events', '--source', path, '--vault', setup.vault);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('mapping file not found');
    const db = openLedger(join(setup.vault, '.kizuki', 'kizuki.db'));
    try { expect(listConnections(db)).toHaveLength(0); } finally { db.close(); }
});
