import { applyConnectionSensitivity, inspectSourceGrant, type Connection, type Manifest, type Sensitivity } from '@kizuki/core';
import { assertSameGmailIdentity, createGmailConnector, inspectGmailState } from '@kizuki/connector-gmail';
import type { Database } from 'bun:sqlite';
import { UsageError } from '../args';
import { ConnectionError, DuplicateSourceError, closeHostConnector, enrollSignedInConnection, listHostConnections } from '../connections';
import { withVault } from '../context';
import { jsonEnvelope } from '../output';
import { consentHint } from '../source-consent';
import { gmailClient, gmailFields, openGmailBrowser, type GmailFactory } from '../gmail';
import type { CliIo } from './index';
export interface GmailEnrollmentOptions {
    source?: string | undefined;
    newSource?: boolean | undefined;
    fields?: string | undefined;
    sensitivity?: Sensitivity | undefined;
    json: boolean;
}
export async function runGmailConnect(io: CliIo, options: GmailEnrollmentOptions, checkSensitivity: (db: Database, manifest: Manifest, requested: Sensitivity | undefined, connection?: Connection) => void, create: GmailFactory = createGmailConnector, openUrl: (url: string) => Promise<void> = openGmailBrowser): Promise<number> {
    if (options.newSource && options.source !== undefined) throw new UsageError("--new-source and --source are mutually exclusive");
    // Configuration refusal precedes terminal checks, prompts, browser or provider I/O.
    const client = await gmailClient(io.env), fields = gmailFields(options.fields);
    if (!io.stdinIsTTY || !io.stderrIsTTY)
        throw new UsageError('connect gmail --fields FIELDS [--source KEY | --new-source] [--json] (interactive desktop terminal required)');
    return withVault(io, async (ctx) => {
        const existing = listHostConnections(ctx.db, ctx.store, 'kizuki.gmail', { includeDisconnected: true });
        if (existing.some(item => item.state === null))
            throw new ConnectionError('Gmail protected state is unavailable. Restore it before reauthorization.');
        const selected = options.newSource ? undefined : options.source === undefined ? existing.length === 1 ? existing[0] : undefined : existing.find(item => item.connection.source_key === options.source);
        if (options.source !== undefined && !selected)
            throw new ConnectionError('No Gmail connection matches this source key.');
        if (!options.newSource && options.source === undefined && existing.length > 1)
            throw new ConnectionError('Several Gmail sources exist; select --source KEY.');
        const previous = selected ? ctx.store.read(selected.connection) : null;
        if (selected && !previous)
            throw new ConnectionError('Gmail protected state is unavailable.');
        const identity = previous ? inspectGmailState(previous) : null;
        if (identity && JSON.stringify([...identity.fields].sort()) !== JSON.stringify([...fields].sort()))
            throw new ConnectionError('Gmail reauthorization must preserve its selected fields and pending history. Use the existing fields; changing source projection is unsupported.');
        const connector = create({ client, fields, ...(identity ? { expected_account: identity.account_id } : {}) }, { ...(previous ? { previousState: previous } : {}) });
        checkSensitivity(ctx.db, connector.manifest(), options.sensitivity, selected?.connection);
        io.err('Gmail will open your system browser for read-only mail access and account identity. Selected data and protected OAuth state stay in this vault. No send/modify access; attachment bodies unsupported. Enrollment captures no history and source consent is separate. Press Ctrl-C to cancel.');
        let connection: Connection;
        try {
            connection = await enrollSignedInConnection(ctx.db, ctx.store, connector, { prompt: async () => { throw new ConnectionError('Gmail does not request pasted keys or authorization codes.'); }, notify: () => { }, openUrl }, options.source, assertSameGmailIdentity, options.newSource);
        }
        catch (error) {
            if (error instanceof DuplicateSourceError) throw error;
            throw new ConnectionError('Gmail sign-in did not complete or account/history identity differed; existing source state was preserved.');
        }
        finally {
            await closeHostConnector(connector);
        }
        applyConnectionSensitivity(ctx.db, connection, connector.manifest(), options.sensitivity);
        const grant = inspectSourceGrant(ctx.db, connection.source_key);
        const result = { connector_id: 'kizuki.gmail', source_key: connection.source_key, state: 'enrolled', capture_started: false, fields, consent: grant?.status ?? 'required', coverage: 'bounded history; 1000-message initial cap; expired history and missing messages report gaps; attachment metadata only', next: grant?.status === 'active' ? `kizuki backfill gmail --source ${connection.source_key}` : consentHint(ctx.db, connection.source_key) };
        if (options.json)
            io.out(jsonEnvelope('connect', 'ok', result));
        else {
            io.out(`connected kizuki.gmail source=${connection.source_key}`);
            io.out(result.coverage);
            io.out(result.next);
        }
        return 0;
    }, { retrieval: 'none' });
}
