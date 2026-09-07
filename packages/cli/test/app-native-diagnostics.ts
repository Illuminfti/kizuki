import { spyOn } from 'bun:test';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import * as context from '../src/context';
import * as receipts from '../../core/src/serve/receipts';

const codes = new Set(['invalid_ledger', 'busy', 'custody_unavailable', 'processing_failed',
    'revision_conflict', 'source_revision_conflict', 'SQLITE_CANTOPEN', 'SQLITE_BUSY', 'SQLITE_LOCKED',
    'SQLITE_READONLY', 'SQLITE_ERROR', 'SQLITE_IOERR', 'SQLITE_CORRUPT', 'SQLITE_NOTADB']);
const messages = ['unable to open database file', 'database is locked', 'database table is locked',
    'attempt to write a readonly database', 'file is not a database'];

/** Synthetic fixtures only. Record metadata and fixed error categories; never
 * database bytes, SQL, provider text, credentials, or absolute fixture paths. */
export function traceSyntheticAppFailures(vault: string) {
    const errors: unknown[] = [];
    const metadata = () => ['kizuki.db', 'kizuki.db-wal', 'kizuki.db-shm', 'kizuki.db-journal'].map(name => {
        try {
            const file = lstatSync(join(vault, '.kizuki', name));
            return { name, size: file.size, mode: file.mode & 0o777, links: file.nlink,
                regular: file.isFile(), mtime: file.mtimeMs, ctime: file.ctimeMs };
        } catch (error) { return { name, observation: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'failed' }; }
    });
    const record = (error: unknown, before: ReturnType<typeof metadata>, boundary: 'context' | 'rail-error') => {
        const candidate = error as { code?: unknown; message?: unknown; stack?: unknown } | null;
        const code = typeof candidate?.code === 'string' && codes.has(candidate.code) ? candidate.code : 'other';
        const message = typeof candidate?.message === 'string' ? messages.find(value => candidate.message === value) ??
            (candidate.message.startsWith('vault ledger is not a Kizuki database') ? 'ledger_identity_refused' : 'other') : 'other';
        const frames = typeof candidate?.stack === 'string'
            ? [...candidate.stack.matchAll(/packages\/(?:core|cli)\/src\/[A-Za-z0-9_./-]+\.ts:\d+:\d+/g)].slice(0, 8).map(match => match[0]) : [];
        errors.push({ boundary, code, message, frames, before, after: metadata() });
        if (errors.length > 8) errors.shift();
    };
    const original = context.withVault;
    const traced: typeof original = async (io, fn, options) => {
        const before = metadata();
        try { return await original(io, fn, options); }
        catch (error) { record(error, before, 'context'); throw error; }
    };
    const redact = receipts.redactReceiptError;
    const railSpy = spyOn(receipts, 'redactReceiptError').mockImplementation(error => {
        record(error, metadata(), 'rail-error'); return redact(error);
    });
    const spy = spyOn(context, 'withVault').mockImplementation(traced);
    return { saw(code: string) { return errors.some(error => (error as { code: string }).code === code); },
    report(stage: 'stale-model-consent' | 'privacy-fixture-processing' | 'privacy-fixture-source-model-consent', operation?: { state: string; error: { code: string } | null; result: unknown }) {
        console.error('synthetic-app-diagnostic ' + JSON.stringify({ stage,
            operation: operation ? { state: operation.state, code: codes.has(operation.error?.code ?? '') ? operation.error?.code : 'other',
                has_result: operation.result !== null } : null, errors, current: metadata() }));
    }, close() { spy.mockRestore(); railSpy.mockRestore(); } };
}
