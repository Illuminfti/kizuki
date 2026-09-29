import { applyConnectionSensitivity, inspectSourceGrant, KizukiError, type Connection, type Manifest, type Sensitivity } from '@kizuki/core';
import { createIcsConnector, type IcsConnectorDeps } from '@kizuki/connectors';
import type { Database } from 'bun:sqlite';
import { ConnectionError, DuplicateSourceError, enrollSignedInConnection } from '../connections';
import { withVault } from '../context';
import { jsonEnvelope } from '../output';
import { consentHint } from '../source-consent';
import { INVOCATION } from '../runtime';
import type { CliIo } from './index';

export interface IcsUrlEnrollmentOptions {
    url: string;
    sensitivity?: Sensitivity | undefined;
    json: boolean;
}

/**
 * Enrolls the calendar connector's URL mode. The address is a credential for a
 * private feed: it reaches the connector as the sign-in answer and is stored
 * only in protected connection state, never in output, errors or SQLite.
 */
export async function runIcsUrlConnect(io: CliIo, options: IcsUrlEnrollmentOptions, checkSensitivity: (db: Database, manifest: Manifest, requested: Sensitivity | undefined, connection?: Connection) => void, deps: IcsConnectorDeps = {}): Promise<number> {
    return withVault(io, async (ctx) => {
        const connector = createIcsConnector({}, deps);
        checkSensitivity(ctx.db, connector.manifest(), options.sensitivity);
        let connection: Connection;
        try {
            // Every URL is its own source, so a file-mode calendar is never replaced.
            connection = await enrollSignedInConnection(ctx.db, ctx.store, connector, { prompt: async () => options.url, notify: () => { }, openUrl: async () => { throw new ConnectionError('Calendar URL sign-in does not open a browser.'); } }, undefined, undefined, true);
        }
        catch (error) {
            if (error instanceof DuplicateSourceError) throw new ConnectionError('source_already_enrolled; this calendar URL is already connected; source consent is unchanged');
            // Typed connector messages never carry the address; anything else might.
            throw new ConnectionError(error instanceof KizukiError ? `Calendar URL was not enrolled: ${error.message}` : 'Calendar URL was not enrolled; check that it is an https calendar feed and retry.');
        }
        applyConnectionSensitivity(ctx.db, connection, connector.manifest(), options.sensitivity);
        const grant = inspectSourceGrant(ctx.db, connection.source_key);
        const next = grant?.status === 'active' ? `${INVOCATION} backfill ics --source ${connection.source_key}` : consentHint(ctx.db, connection.source_key);
        if (options.json)
            io.out(jsonEnvelope('connect', 'ok', { connector_id: 'kizuki.ics', source_key: connection.source_key, state: 'enrolled', capture_started: false, mode: 'https-url', consent: grant?.status ?? 'required', next }));
        else {
            io.out(`connected kizuki.ics source=${connection.source_key}`);
            io.out('Calendar feed re-read each pass with ETag validation; the address stays in protected connection state.');
            io.out(next);
        }
        return 0;
    }, { retrieval: 'none' });
}
