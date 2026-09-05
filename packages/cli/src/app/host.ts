import { basename, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { OWNER, getClaimsEpoch, sourcePolicyEpoch, getCheckpoint, initAgents, inspectSourceGrant, listAuditReceipts, listConnections, resumeSourceRevocation, revokeSourceGrant, runBackfill, runSync, serveSearch, setSourceGrant, undoReceipt, withDeadline } from '@kizuki/core';
import type { Connector, SourceGrantPolicy } from '@kizuki/core';
import { createGmailConnector, inspectGmailState, assertSameGmailIdentity } from '@kizuki/connector-gmail';
import { createGoogleCalendarConnector, inspectGoogleCalendarState, assertSameGoogleCalendarIdentity } from '@kizuki/connector-google-calendar';
import { withVault, resolveVault } from '../context';
import { configPath, readConfig } from '../config';
import { closeHostConnector, DuplicateSourceError, enrollHostConnection, enrollSignedInConnection, listHostConnections, loadConnector, selectConnection } from '../connections';
import { gmailClient, gmailFields, gmailRequiredFields, openGmailBrowser, type GmailFactory } from '../gmail';
import { googleCalendarClient, googleCalendarFields, googleCalendarRequiredFields, googleCalendarId, openGoogleCalendarBrowser, type GoogleCalendarFactory } from '../google-calendar';
import { createOwnedRetrievalInventory } from '../owned-retrieval-inventory';
import { tryRefreshDerived } from '../derived';
import { initCommand } from '../commands/init';
import type { CliIo } from '../commands';
import type { AppCatalogEntry, AppError, AppOperation, AppRoute, AppSource } from './protocol';
export interface AppHostDeps {
    gmail?: GmailFactory;
    calendar?: GoogleCalendarFactory;
    openGoogleUrl?: (url: string) => Promise<void>;
}
class AppFailure extends Error {
    constructor(readonly code: string) { super(code); }
}
const ROUTES: Record<AppRoute, readonly string[]> = {
    status: [], catalog: [], initialize: ['path'], sources: [], enroll: ['provider', 'path', 'fields', 'calendar_id', 'source_key', 'new_source'],
    consent: ['source_key', 'expected_revision', 'operation_id', 'policy'], capture: ['source_key', 'mode'], query: ['text', 'limit'], activity: ['limit'], undo: ['receipt_id', 'cascade'], operation: ['id'],
    revoke: ['source_key', 'expected_revision', 'operation_id'], resume_revocation: ['source_key', 'operation_id'],
};
function object(value: unknown): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new AppFailure('invalid_request'); return value as Record<string, unknown>; }
function string(value: unknown, max = 4096): string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    throw new AppFailure('invalid_request'); return value; }
function boolean(value: unknown): boolean { if (value === undefined)
    return false; if (typeof value !== 'boolean')
    throw new AppFailure('invalid_request'); return value; }
function limit(value: unknown): number { if (value === undefined)
    return 20; if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 50)
    throw new AppFailure('invalid_request'); return Number(value); }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new AppFailure('invalid_request'); return Number(value); }
function sourceKey(value: unknown): string { const key = string(value, 26); if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(key))
    throw new AppFailure('invalid_request'); return key; }
function failure(error: unknown): AppError {
    if (error instanceof DuplicateSourceError) return { code: 'duplicate_identity', retryable: false };
    const code = error instanceof AppFailure ? error.code : error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const allowed = ['invalid_request', 'no_vault', 'busy', 'unauthorized', 'consent_required', 'source_capture_denied', 'source_field_denied', 'revision_conflict', 'source_not_enrolled', 'misconfigured', 'identity_conflict', 'custody_unknown'];
    return { code: allowed.includes(code) ? code : 'unavailable', retryable: ['busy', 'unavailable'].includes(code) };
}
const fullFields = ['text', 'subjects', 'metadata', 'attachments'];
export function createAppHost(baseIo: CliIo, deps: AppHostDeps = {}) {
    const config = readConfig(configPath(baseIo.env));
    const hasSelection = baseIo.vaultOverride !== null || Boolean(baseIo.env.KIZUKI_VAULT) || Boolean(config.default_vault);
    let selected = hasSelection ? resolveVault(baseIo.env, config, baseIo.vaultOverride) : join(baseIo.env.HOME ?? homedir(), 'Kizuki');
    const jobs = new Map<string, AppOperation>(), pending = new Set<Promise<void>>(), active = new Set<Connector>();
    let mutation = false, closed = false;
    const io = (): CliIo => ({ ...baseIo, vaultOverride: selected, out: () => { }, err: () => { }, prompt: async () => { throw new AppFailure('unavailable'); } });
    const ready = () => existsSync(join(selected, '.kizuki', 'kizuki.db'));
    const context = <T>(fn: Parameters<typeof withVault<T>>[1]) => { if (!ready())
        throw new AppFailure('no_vault'); return withVault(io(), fn, { retrieval: 'none' }); };
    function operation(kind: string, work: (job: AppOperation) => Promise<AppOperation['result']>, urgent = false) {
        if (closed || mutation && !urgent)
            throw new AppFailure('busy');
        if (jobs.size >= 32) {
            const old = [...jobs.values()].find(item => item.state !== 'running');
            if (!old)
                throw new AppFailure('busy');
            jobs.delete(old.id);
        }
        const job: AppOperation = { id: randomUUID(), kind, state: 'running', stage: 'starting', counts: null, result: null, error: null };
        jobs.set(job.id, job);
        if (!urgent)
            mutation = true;
        const task = Promise.resolve().then(() => work(job)).then(result => { job.result = result; job.stage = 'complete'; job.state = 'succeeded'; }, error => { job.error = failure(error); job.stage = 'stopped'; job.state = 'failed'; }).finally(() => { if (!urgent)
            mutation = false; pending.delete(task); });
        pending.add(task);
        return { operation_id: job.id };
    }
    function catalog(): AppCatalogEntry[] {
        return [
            { id: 'markdown', title: 'Local notes', available: true, detail: 'Choose a local Markdown folder. Consent is required before reading history.', fields: [], required_fields: ['text', 'subjects', 'metadata'] },
            { id: 'gmail', title: 'Gmail', available: /^[A-Za-z0-9._-]{1,512}$/.test(baseIo.env.KIZUKI_GMAIL_CLIENT_ID ?? ''), detail: 'Configure operator KIZUKI_GMAIL_CLIENT_ID to enable browser sign-in. No app registration is performed here. Read-only Gmail permission and source consent are separate.', fields: ['text', 'subjects', 'headers', 'labels', 'attachments'], required_fields: fullFields },
            { id: 'google-calendar', title: 'Google Calendar', available: /^[A-Za-z0-9._-]{1,512}$/.test(baseIo.env.KIZUKI_GOOGLE_CALENDAR_CLIENT_ID ?? ''), detail: 'Configure operator KIZUKI_GOOGLE_CALENDAR_CLIENT_ID to enable browser sign-in. Google permits viewing all calendars; Kizuki reads only your selected calendar.', fields: ['summary', 'description', 'location', 'attendees', 'attachments'], required_fields: fullFields },
        ];
    }
    async function execute(route: AppRoute, input: Record<string, unknown>): Promise<unknown> {
        if (route === 'catalog')
            return { sources: catalog() };
        if (route === 'status') {
            const epoch = ready() ? await context(async (ctx) => `${sourcePolicyEpoch(ctx.db)}:${getClaimsEpoch(ctx.db)}`) : 'uninitialized';
            return { visibility_epoch: epoch, vault: { ready: ready(), name: basename(selected) }, setup_location: selected, service: { state: 'not_verified', detail: 'This app is a local client. It does not start a writer daemon.' }, operations: [...jobs.values()] };
        }
        if (route === 'operation') {
            const id = string(input.id, 128);
            return jobs.get(id) ?? { id, kind: 'unknown', state: 'unknown', stage: 'unknown', counts: null, result: null, error: null };
        }
        if (route === 'initialize') {
            const path = input.path === undefined ? selected : resolve(string(input.path));
            return operation('initialize', async () => {
                if (ready())
                    throw new AppFailure('invalid_request');
                const code = await initCommand.run({ ...io(), vaultOverride: null }, [path, '--default', '--no-service']);
                if (code !== 0)
                    throw new AppFailure('unavailable');
                selected = path;
                return { message: 'Vault created. Background service was not installed.' };
            });
        }
        if (route === 'sources')
            return context(async (ctx) => {
                const rows = listConnections(ctx.db, { includeDisconnected: true });
                if (rows.length > 64)
                    throw new AppFailure('unavailable');
                return { sources: rows.map(row => {
                        const grant = inspectSourceGrant(ctx.db, row.source_key), checkpoint = getCheckpoint(ctx.db, row.connector_id, row.source_key);
                        let required = ['text', 'subjects', 'metadata'], state = row.disconnected_at ? 'disconnected' : 'enrolled';
                        if (row.connector_id === 'kizuki.gmail' || row.connector_id === 'kizuki.google-calendar') {
                            // Explicit authenticated owner inspection; never reused for capture admission.
                            try {
                                const bytes = ctx.store.read(row);
                                if (!bytes)
                                    throw new Error();
                                required = row.connector_id === 'kizuki.gmail' ? gmailRequiredFields(inspectGmailState(bytes).fields) : googleCalendarRequiredFields(inspectGoogleCalendarState(bytes).fields);
                            }
                            catch {
                                required = [];
                                state = 'needs_attention';
                            }
                        }
                        const source: AppSource = { source_key: row.source_key, connector_id: row.connector_id, display_name: row.connector_id.replace('kizuki.', ''), state, consent: grant?.status ?? 'required', revision: grant?.revision ?? 0, required_fields: required, last_run: checkpoint?.last_run_at ?? null, stored: checkpoint?.last_result.stored ?? 0, errors: checkpoint?.last_result.errors.length ?? 0, revoke_operation: grant?.revoke_operation ?? null, purge_blockers: grant?.purge_blockers ?? [] };
                        return source;
                    }) };
            });
        if (route === 'query') {
            const query = string(input.text, 2000), count = limit(input.limit);
            return context(async (ctx) => {
                initAgents(ctx.db);
                const result = await serveSearch({ db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER }, { query, scope: 'all', limit: count });
                return { hits: [...result.canon.map(hit => ({ id: hit.page_id, scope: 'canon', title: hit.title, text: hit.excerpt, citations: hit.sources, sensitivity: hit.sensitivity })), ...result.quoted.map(hit => ({ id: hit.event_id, scope: 'ledger', title: hit.connector_id, text: hit.text, citations: [hit.event_id], sensitivity: hit.sensitivity }))], withheld: result.denied.reduce((n, item) => n + item.count, 0), degraded: result.data?.degraded ?? [] };
            });
        }
        if (route === 'activity') {
            const count = limit(input.limit);
            return context(async (ctx) => ({ receipts: listAuditReceipts(ctx.db, { limit: count }).map(row => ({ id: row.receipt_id, at: row.at, action: row.page_action, page: row.page_path, reverted: row.reverted_by !== null })) }));
        }
        if (route === 'consent') {
            const key = sourceKey(input.source_key), expected = revision(input.expected_revision), id = string(input.operation_id, 128);
            return context(async (ctx) => {
                const result = setSourceGrant(ctx.db, { source_key: key, expected_revision: expected, operation_id: id, policy: object(input.policy) as unknown as SourceGrantPolicy });
                return { source_key: key, revision: result.revision, status: result.status };
            });
        }
        if (route === 'revoke') {
            const key = sourceKey(input.source_key), expected = revision(input.expected_revision), id = string(input.operation_id, 128);
            return operation('revoke', async () => context(async (ctx) => {
                revokeSourceGrant(ctx.db, { source_key: key, expected_revision: expected, operation_id: id });
                return { source_key: key, message: 'Access denied. Physical erasure remains a separate resumable operation.' };
            }), true);
        }
        if (route === 'resume_revocation') {
            const key = sourceKey(input.source_key), id = string(input.operation_id, 128);
            return operation('resume_revocation', async () => context(async (ctx) => {
                const before = inspectSourceGrant(ctx.db, key);
                if (!before || before.revoke_operation !== id)
                    throw new AppFailure('invalid_request');
                const inventory = createOwnedRetrievalInventory(ctx.vaultPath);
                let result;
                try {
                    result = await resumeSourceRevocation(ctx.db, ctx.vaultPath, id, { ownedRetrieval: inventory });
                }
                finally {
                    await inventory.close();
                }
                return { source_key: key, message: result.status === 'purged' && result.purge_blockers.length === 0 && !inventory.diagnostic() ? 'Owned erasure completed; external copies are outside this operation.' : 'Access remains denied; erasure is pending.' };
            }));
        }
        if (route === 'undo') {
            const id = string(input.receipt_id, 128), cascade = boolean(input.cascade);
            return operation('undo', async () => context(async (ctx) => {
                const result = await undoReceipt({ db: ctx.db, vault_path: ctx.vaultPath }, id, { cascade });
                tryRefreshDerived(ctx.db, ctx.vaultPath);
                return { receipt_id: result.receipt_id, message: 'Receipt undone.' };
            }));
        }
        if (route === 'capture') {
            const key = sourceKey(input.source_key), mode = string(input.mode, 8);
            if (mode !== 'backfill' && mode !== 'sync')
                throw new AppFailure('invalid_request');
            return operation('capture', async (job) => context(async (ctx) => {
                const row = listConnections(ctx.db).find(item => item.source_key === key);
                if (!row)
                    throw new AppFailure('invalid_request');
                const connection = selectConnection(ctx.db, ctx.store, row.connector_id, key), connector = await loadConnector(connection, ctx.store, ctx.db, baseIo.env);
                active.add(connector);
                try {
                    job.stage = 'capturing';
                    job.counts = { stored: 0, duplicates: 0, errors: 0 };
                    for (let batch = 0; batch < 10; batch++) {
                        if (closed)
                            throw new AppFailure('custody_unknown');
                        const before = getCheckpoint(ctx.db, row.connector_id, key)?.cursor ?? null;
                        const result = await (mode === 'backfill' ? runBackfill : runSync)(ctx.db, connector, row.connector_id, key);
                        job.counts.stored += result.stored;
                        job.counts.duplicates += result.duplicates;
                        job.counts.errors += result.errors.length;
                        if (result.errors.length)
                            throw new AppFailure('unavailable');
                        const after = getCheckpoint(ctx.db, row.connector_id, key)?.cursor ?? null;
                        if (after === before)
                            break;
                    }
                    tryRefreshDerived(ctx.db, ctx.vaultPath);
                    return { source_key: key, message: 'Bounded capture pass finished. Coverage and pending history remain source-specific.' };
                }
                finally {
                    try {
                        await closeHostConnector(connector);
                    }
                    finally {
                        active.delete(connector);
                    }
                }
            }));
        }
        if (route === 'enroll') {
            const provider = string(input.provider, 32), newSource = boolean(input.new_source), key = input.source_key === undefined ? undefined : sourceKey(input.source_key);
            if (newSource && key !== undefined)
                throw new AppFailure('invalid_request');
            if (provider === 'markdown') {
                if (input.fields !== undefined || input.calendar_id !== undefined || key !== undefined || newSource)
                    throw new AppFailure('invalid_request');
                const path = resolve(string(input.path));
                return operation('enroll', async () => context(async (ctx) => {
                    const old = listHostConnections(ctx.db, ctx.store, 'kizuki.markdown-folder', { includeDisconnected: true }).find(item => item.state?.config.path === path);
                    if (old)
                        return { source_key: old.connection.source_key, message: 'Existing source selected; consent unchanged.' };
                    const row = await enrollHostConnection(ctx.db, ctx.store, 'kizuki.markdown-folder', { schema: 'kizuki.cli.connection-state/v1', connector_id: 'kizuki.markdown-folder', config: { path } });
                    return { source_key: row.source_key, message: 'Folder enrolled. Grant consent before capture.' };
                }));
            }
            if (provider !== 'gmail' && provider !== 'google-calendar' || input.path !== undefined)
                throw new AppFailure('invalid_request');
            if (!Array.isArray(input.fields) || input.fields.some(field => typeof field !== 'string'))
                throw new AppFailure('invalid_request');
            const fields = provider === 'gmail' ? gmailFields(input.fields.join(',')) : googleCalendarFields(input.fields.length ? input.fields.join(',') : 'none');
            const calendar = provider === 'google-calendar' ? googleCalendarId(input.calendar_id === undefined ? undefined : string(input.calendar_id, 1024)) : undefined;
            if (provider === 'gmail' && input.calendar_id !== undefined)
                throw new AppFailure('invalid_request');
            return operation('enroll', async (job) => {
                // Configuration refusal precedes protected state, browser and provider I/O.
                const client = await (provider === 'gmail' ? gmailClient : googleCalendarClient)(baseIo.env);
                return context(async (ctx) => {
                    const id = provider === 'gmail' ? 'kizuki.gmail' : 'kizuki.google-calendar', rows = listConnections(ctx.db, { includeDisconnected: true }).filter(row => row.connector_id === id);
                    const previous = newSource ? undefined : key === undefined ? (rows.length === 1 ? rows[0] : undefined) : rows.find(row => row.source_key === key);
                    if (key !== undefined && !previous || !newSource && key === undefined && rows.length > 1)
                        throw new AppFailure('invalid_request');
                    const bytes = previous ? ctx.store.read(previous) : null;
                    if (previous && !bytes)
                        throw new AppFailure('unavailable');
                    const identity = bytes ? (provider === 'gmail' ? inspectGmailState(bytes) : inspectGoogleCalendarState(bytes)) : null;
                    if (identity && (JSON.stringify(identity.fields) !== JSON.stringify(fields) || 'calendar_id' in identity && identity.calendar_id !== calendar))
                        throw new AppFailure('identity_conflict');
                    const runtime = bytes ? { previousState: bytes } : {};
                    const connector = provider === 'gmail' ? (deps.gmail ?? createGmailConnector)({ client, fields: gmailFields((input.fields as string[]).join(',')), ...(identity ? { expected_account: identity.account_id } : {}) }, runtime) : (deps.calendar ?? createGoogleCalendarConnector)({ client, calendar_id: calendar!, fields: googleCalendarFields((input.fields as string[]).length ? (input.fields as string[]).join(',') : 'none'), ...(identity ? { expected_account: identity.account_id } : {}) }, runtime);
                    active.add(connector);
                    job.stage = 'awaiting_google';
                    try {
                        const row = await enrollSignedInConnection(ctx.db, ctx.store, connector, { prompt: async () => { throw new AppFailure('unavailable'); }, notify: () => { }, openUrl: deps.openGoogleUrl ?? (provider === 'gmail' ? openGmailBrowser : openGoogleCalendarBrowser) }, key, provider === 'gmail' ? assertSameGmailIdentity : assertSameGoogleCalendarIdentity, newSource);
                        return { source_key: row.source_key, message: 'Source enrolled. Consent is separate from Google authorization.' };
                    }
                    finally {
                        try {
                            await closeHostConnector(connector);
                        }
                        finally {
                            active.delete(connector);
                        }
                    }
                });
            });
        }
        throw new AppFailure('invalid_request');
    }
    return {
        async handle(request: Request): Promise<Response> {
            try {
                if (closed)
                    throw new AppFailure('unavailable');
                const route = new URL(request.url).pathname.slice('/app/v1/'.length);
                if (!Object.hasOwn(ROUTES, route))
                    throw new AppFailure('invalid_request');
                const input = object(await request.json());
                if (Object.keys(input).some(key => !ROUTES[route as AppRoute].includes(key)))
                    throw new AppFailure('invalid_request');
                return Response.json({ ok: true, data: await execute(route as AppRoute, input) });
            }
            catch (error) {
                return Response.json({ ok: false, error: failure(error) }, { status: 400 });
            }
        },
        async close() { closed = true; try {
            await withDeadline(Promise.all([...active].map(connector => closeHostConnector(connector))).then(() => Promise.allSettled([...pending])), 5000, 'app shutdown deadline');
        }
        catch {
            throw new AppFailure('custody_unknown');
        } },
    };
}
