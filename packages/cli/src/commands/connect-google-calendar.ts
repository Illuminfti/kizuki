import { applyConnectionSensitivity, inspectSourceGrant, type Connection, type Manifest, type Sensitivity } from '@kizuki/core';
import { assertSameGoogleCalendarIdentity, createGoogleCalendarConnector, inspectGoogleCalendarState } from '@kizuki/connector-google-calendar';
import type { Database } from 'bun:sqlite';
import { UsageError } from '../args';
import { ConnectionError, DuplicateSourceError, closeHostConnector, enrollSignedInConnection, listHostConnections } from '../connections';
import { withVault } from '../context';
import { jsonEnvelope } from '../output';
import { consentHint } from '../source-consent';
import { googleCalendarClient, googleCalendarFields, googleCalendarId, googleCalendarRequiredFields, openGoogleCalendarBrowser, type GoogleCalendarFactory } from '../google-calendar';
import type { CliIo } from './index';
export interface GoogleCalendarEnrollmentOptions {
    source?: string | undefined;
    newSource?: boolean | undefined;
    fields?: string | undefined;
    calendar?: string | undefined;
    sensitivity?: Sensitivity | undefined;
    json: boolean;
}
export async function runGoogleCalendarConnect(io: CliIo, options: GoogleCalendarEnrollmentOptions, checkSensitivity: (db: Database, manifest: Manifest, requested: Sensitivity | undefined, connection?: Connection) => void, create: GoogleCalendarFactory = createGoogleCalendarConnector, openUrl: (url: string) => Promise<void> = openGoogleCalendarBrowser): Promise<number> {
    if (options.newSource && options.source !== undefined) throw new UsageError("--new-source and --source are mutually exclusive");
    // Configuration refusal precedes terminal checks, prompts, browser or provider I/O.
    const calendar = googleCalendarId(options.calendar), fields = googleCalendarFields(options.fields), client = await googleCalendarClient(io.env);
    if (!io.stdinIsTTY || !io.stderrIsTTY)
        throw new UsageError('connect google-calendar --calendar CANONICAL_ID --fields FIELDS [--source KEY | --new-source] [--json] (interactive desktop terminal required)');
    return withVault(io, async (ctx) => {
        const existing = listHostConnections(ctx.db, ctx.store, 'kizuki.google-calendar', { includeDisconnected: true });
        if (existing.some(item => item.state === null))
            throw new ConnectionError('Google Calendar protected state is unavailable. Restore it before reauthorization.');
        const selected = options.newSource ? undefined : options.source === undefined ? existing.length === 1 ? existing[0] : undefined : existing.find(item => item.connection.source_key === options.source);
        if (options.source !== undefined && !selected)
            throw new ConnectionError('No Google Calendar connection matches this source key.');
        if (!options.newSource && options.source === undefined && existing.length > 1)
            throw new ConnectionError('Several Google Calendar sources exist; select --source KEY.');
        const previous = selected ? ctx.store.read(selected.connection) : null;
        if (selected && !previous)
            throw new ConnectionError('Google Calendar protected state is unavailable.');
        const identity = previous ? inspectGoogleCalendarState(previous) : null;
        if (identity && (identity.calendar_id !== calendar || JSON.stringify([...identity.fields].sort()) !== JSON.stringify([...fields].sort())))
            throw new ConnectionError('Google Calendar reauthorization must preserve its selected calendar, fields, pending page, anchors and cooldown. Use the existing fields; changing source projection is unsupported.');
        const connector = create({ client, calendar_id: calendar, fields, ...(identity ? { expected_account: identity.account_id } : {}) }, { ...(previous ? { previousState: previous } : {}) });
        checkSensitivity(ctx.db, connector.manifest(), options.sensitivity, selected?.connection);
        io.err('Google Calendar will open your system browser for read-only calendar event access and account identity. Google grants read-only access to events on all calendars. Kizuki reads only the calendar you selected and stores only selected fields plus required identity/schedule metadata. Selected data and protected OAuth state stay in this vault. No event modification access; attachment bodies unsupported. Enrollment captures no history and source consent is separate. Press Ctrl-C to cancel.');
        let connection: Connection;
        try {
            connection = await enrollSignedInConnection(ctx.db, ctx.store, connector, { prompt: async () => { throw new ConnectionError('Google Calendar does not request pasted keys or authorization codes.'); }, notify: () => { }, openUrl }, options.source, assertSameGoogleCalendarIdentity, options.newSource);
        }
        catch (error) {
            if (error instanceof DuplicateSourceError) throw error;
            throw new ConnectionError('Google Calendar sign-in did not complete or account/history identity differed; inspect protected state before retrying.');
        }
        finally {
            await closeHostConnector(connector);
        }
        applyConnectionSensitivity(ctx.db, connection, connector.manifest(), options.sensitivity);
        const grant = inspectSourceGrant(ctx.db, connection.source_key);
        const result = { connector_id: 'kizuki.google-calendar', source_key: connection.source_key, state: 'enrolled', capture_started: false, calendar_id:calendar, fields, required_grant_fields:googleCalendarRequiredFields(fields), consent: grant?.status ?? 'required', coverage: 'bounded calendar revisions; 1000-event initial scan and cancellation-anchor caps; expired sync tokens report gaps; recurrence not expanded; attachment metadata only', next: grant?.status === 'active' ? `kizuki backfill google-calendar --source ${connection.source_key}` : consentHint(ctx.db, connection.source_key) };
        if (options.json)
            io.out(jsonEnvelope('connect', 'ok', result));
        else {
            io.out(`connected kizuki.google-calendar source=${connection.source_key}`);
            io.out(result.coverage);
            io.out(result.next);
        }
        return 0;
    }, { retrieval: 'none' });
}
