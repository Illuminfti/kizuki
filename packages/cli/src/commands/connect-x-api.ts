import { applyConnectionSensitivity, inspectSourceGrant, type Connection, type Manifest, type Sensitivity } from '@kizuki/core';
import { assertSameXApiIdentity, createXApiConnector, inspectXApiState } from '@kizuki/connectors';
import { loopbackTransport, type LoopbackListener } from '@kizuki/core';
import type { Database } from 'bun:sqlite';
import { UsageError } from '../args';
import { ConnectionError, DuplicateSourceError, closeHostConnector, enrollSignedInConnection, listHostConnections } from '../connections';
import { withVault } from '../context';
import { jsonEnvelope } from '../output';
import { consentHint } from '../source-consent';
import { xApiClient, xApiSelection, openXApiBrowser, type XApiFactory } from '../x-api';
import type { CliIo } from './index';
export interface XApiEnrollmentOptions {
    source?: string | undefined;
    newSource?: boolean | undefined;
    fields?: string | undefined;
    historyStart?: string | undefined;
    sensitivity?: Sensitivity | undefined;
    json: boolean;
}
export async function runXApiConnect(io: CliIo, options: XApiEnrollmentOptions, checkSensitivity: (db: Database, manifest: Manifest, requested: Sensitivity | undefined, connection?: Connection) => void, create: XApiFactory = createXApiConnector, openUrl: (url: string) => Promise<void> = openXApiBrowser): Promise<number> {
    if (options.newSource && options.source !== undefined) throw new UsageError("--new-source and --source are mutually exclusive");
    // Configuration refusal precedes terminal checks, prompts, browser or provider I/O.
    const client = xApiClient(io.env), selection = xApiSelection(options.fields, options.historyStart);
    if (!io.stdinIsTTY || !io.stderrIsTTY)
        throw new UsageError('connect x-api --fields FIELDS --history-start RFC3339 [--source KEY | --new-source] [--json] (interactive desktop terminal required)');
    return withVault(io, async (ctx) => {
        const existing = listHostConnections(ctx.db, ctx.store, 'kizuki.x', { includeDisconnected: true });
        if (existing.some(item => item.state === null))
            throw new ConnectionError('X protected state is unavailable. Restore it before reauthorization.');
        const selected = options.newSource ? undefined : options.source === undefined ? existing.length === 1 ? existing[0] : undefined : existing.find(item => item.connection.source_key === options.source);
        if (options.source !== undefined && !selected)
            throw new ConnectionError('No X connection matches this source key.');
        if (!options.newSource && options.source === undefined && existing.length > 1)
            throw new ConnectionError('Several X sources exist; select --source KEY.');
        const previous = selected ? ctx.store.read(selected.connection) : null;
        if (selected && !previous)
            throw new ConnectionError('X protected state is unavailable.');
        const identity = previous ? inspectXApiState(previous) : null;
        if (identity && JSON.stringify(identity.selection) !== JSON.stringify(selection))
            throw new ConnectionError('X reauthorization must preserve its selected fields and pending history. Use the existing fields; changing source projection is unsupported.');
        const native = loopbackTransport({ redirectUri: client.redirectUri });
        let listener: LoopbackListener | null = null;
        const connector = create({ client_id: client.id, selection, ...(identity ? { expected_account: identity.account_id } : {}) }, { oauth: { postForm: native.postForm, listen: async path => { listener = await native.listen(path); return listener; } } });
        checkSensitivity(ctx.db, connector.manifest(), options.sensitivity, selected?.connection);
        io.err('X will open your system browser for read-only own-post access, account identity and offline access. Selected data and protected OAuth state stay in this vault. No posting or direct-message access. Enrollment captures no history; source consent is separate. API access requires an eligible native app and usage credits. Press Ctrl-C to cancel.');
        let connection: Connection;
        try {
            connection = await enrollSignedInConnection(ctx.db, ctx.store, connector, { prompt: async () => { throw new ConnectionError('X does not request pasted keys or authorization codes.'); }, notify: () => { }, openUrl: async url => {
                try { await openUrl(url); }
                catch {
                    // This CLI keeps authorization URLs out of logs and JSON. With no
                    // printed manual fallback, close its pending callback and offer retry.
                    if (listener !== null) await listener.close();
                    throw new ConnectionError('X browser launch failed; retry in a supported desktop session.');
                }
            } }, options.source, assertSameXApiIdentity, options.newSource);
        }
        catch (error) {
            if (error instanceof DuplicateSourceError) throw error;
            throw new ConnectionError('X sign-in did not complete or account/history identity differed; existing source state was preserved.');
        }
        finally {
            try { await closeHostConnector(connector); }
            finally { if (listener !== null) await (listener as LoopbackListener).close(); }
        }
        applyConnectionSensitivity(ctx.db, connection, connector.manifest(), options.sensitivity);
        const grant = inspectSourceGrant(ctx.db, connection.source_key);
        const result = { connector_id: 'kizuki.x', source_key: connection.source_key, state: 'enrolled', capture_started: false, selection, consent: grant?.status ?? 'required', coverage: 'bounded own-post API window; history is capped; provider deletion coverage unavailable; media references only', next: grant?.status === 'active' ? `kizuki backfill x-api --source ${connection.source_key}` : consentHint(ctx.db, connection.source_key) };
        if (options.json)
            io.out(jsonEnvelope('connect', 'ok', result));
        else {
            io.out(`connected kizuki.x source=${connection.source_key}`);
            io.out(result.coverage);
            io.out(result.next);
        }
        return 0;
    }, { retrieval: 'none' });
}
