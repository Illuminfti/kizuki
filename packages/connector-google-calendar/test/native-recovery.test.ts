import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConnectionStateStore, createStatePersister, getConnection, getCheckpoint, openLedger, runToCompletion, setSourceGrant } from "@kizuki/core";
import { GOOGLE_CALENDAR_CONNECTOR_ID } from "../src/index";
import { CalendarFixture } from "../src/testing";
test("native runToCompletion reopens persisted deletion observation after lost state-write response, before tombstone", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-native-"));
    const database = join(root, "ledger.db");
    let db = openLedger(database);
    try {
        const fixture = new CalendarFixture(), store = new ConnectionStateStore(root);
        const enrollment = store.begin();
        await enrollment.writer.write(fixture.state);
        let connection = store.save(db, GOOGLE_CALENDAR_CONNECTOR_ID, enrollment.pending);
        const source = connection.source_key;
        setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "synthetic-calendar-grant", policy: { purposes: ["capture"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" } });
        let handle = createStatePersister(db, store, connection);
        let connector = await fixture.connected(async (bytes) => { await handle.persist(bytes); fixture.state = bytes; });
        const captured = await runToCompletion(db, connector, GOOGLE_CALENDAR_CONNECTOR_ID, source, "backfill");
        expect(captured.errors).toEqual([]);
        expect(captured.stored).toBe(2);
        const original = getCheckpoint(db, GOOGLE_CALENDAR_CONNECTOR_ID, source)!.cursor;
        fixture.advance();
        fixture.rows = [{ id: "allday1", status: "cancelled" }];
        fixture.version++;
        connector = await fixture.connected(async (bytes) => { await handle.persist(bytes); throw new Error("synthetic lost state response"); });
        const interrupted = await runToCompletion(db, connector, GOOGLE_CALENDAR_CONNECTOR_ID, source, "sync");
        expect(interrupted.errors.length).toBeGreaterThan(0);
        expect(getCheckpoint(db, GOOGLE_CALENDAR_CONNECTOR_ID, source)!.cursor).toBe(original);
        const saved = store.read(handle.current())!;
        const observation = JSON.parse(new TextDecoder().decode(saved)).pending.observed_at;
        expect(new TextDecoder().decode(saved)).not.toContain("Synthetic all-day");
        db.close();
        db = openLedger(database);
        const reopenedStore = new ConnectionStateStore(root);
        expect(reopenedStore.recover(db).unresolved).toEqual([]);
        connection = getConnection(db, GOOGLE_CALENDAR_CONNECTOR_ID, source)!;
        fixture.state = reopenedStore.read(connection)!;
        fixture.advance();
        handle = createStatePersister(db, reopenedStore, connection);
        connector = await fixture.connected(async (bytes) => { await handle.persist(bytes); fixture.state = bytes; });
        const recovered = await runToCompletion(db, connector, GOOGLE_CALENDAR_CONNECTOR_ID, source, "sync");
        expect(recovered.errors).toEqual([]);
        expect(recovered.stored).toBe(1);
        const rows = db.query("SELECT occurred_at, observed_at, metadata FROM events WHERE deleted=1").all() as Record<string, unknown>[];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.occurred_at).toBe(observation);
        expect(rows[0]!.observed_at).toBe(observation);
        expect(JSON.parse(rows[0]!.metadata as string).provider_deleted_at).toBeNull();
        // Public replay from the actual durable checkpoint does not mint another deletion.
        const retried = await runToCompletion(db, connector, GOOGLE_CALENDAR_CONNECTOR_ID, source, "sync");
        expect(retried.errors).toEqual([]);
        expect(retried.stored).toBe(0);
    }
    finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
    }
});
for (const boundary of ["before-accept", "after-accept"] as const) {
    for (const edited of [false, true]) {
        test(`native live retry ${boundary} ${edited ? "refuses provider edit" : "reuses unchanged version"}`, async () => {
            const root = mkdtempSync(join(tmpdir(), "calendar-live-native-"));
            const database = join(root, "ledger.db");
            let db = openLedger(database);
            try {
                const fixture = new CalendarFixture();
                let store = new ConnectionStateStore(root);
                const enrollment = store.begin();
                await enrollment.writer.write(fixture.state);
                let connection = store.save(db, GOOGLE_CALENDAR_CONNECTOR_ID, enrollment.pending);
                const source = connection.source_key;
                setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "synthetic-calendar-grant", policy: { purposes: ["capture"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" } });
                let handle = createStatePersister(db, store, connection);
                let witnessWritten = false;
                let connector = await fixture.connected(async (bytes) => {
                    await handle.persist(bytes);
                    fixture.state = bytes;
                    if (JSON.parse(new TextDecoder().decode(bytes)).pending?.fingerprints) {
                        witnessWritten = true;
                        if (boundary === "before-accept")
                            throw Error("synthetic lost durable witness response");
                    }
                });
                if (boundary === "after-accept") {
                    db.exec("CREATE TRIGGER interrupt_calendar_checkpoint BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(FAIL,'synthetic checkpoint interruption'); END");
                    await expect(runToCompletion(db, connector, GOOGLE_CALENDAR_CONNECTOR_ID, source, "backfill")).rejects.toThrow("synthetic checkpoint interruption");
                }
                else {
                    const stopped = await runToCompletion(db, connector, GOOGLE_CALENDAR_CONNECTOR_ID, source, "backfill");
                    expect(stopped.errors.length).toBeGreaterThan(0);
                    expect(stopped.stored).toBe(0);
                }
                expect(witnessWritten).toBe(true);
                expect(getCheckpoint(db, GOOGLE_CALENDAR_CONNECTOR_ID, source)?.cursor ?? null).toBeNull();
                const before = db.query("SELECT * FROM events ORDER BY event_id").all();
                expect(before).toHaveLength(boundary === "after-accept" ? 2 : 0);
                const pendingBytes = store.read(handle.current())!;
                expect(new TextDecoder().decode(pendingBytes)).not.toContain("Synthetic all-day");
                db.close();
                db = openLedger(database);
                if (boundary === "after-accept")
                    db.exec("DROP TRIGGER interrupt_calendar_checkpoint");
                store = new ConnectionStateStore(root);
                expect(store.recover(db).unresolved).toEqual([]);
                connection = getConnection(db, GOOGLE_CALENDAR_CONNECTOR_ID, source)!;
                fixture.state = store.read(connection)!;
                fixture.advance();
                if (edited) {
                    fixture.rows[0]!.summary = "Changed synthetic version";
                    fixture.rows[0]!.updated = "2024-01-04T00:00:00Z";
                }
                handle = createStatePersister(db, store, connection);
                connector = await fixture.connected(async (bytes) => { await handle.persist(bytes); fixture.state = bytes; });
                const resumed = await runToCompletion(db, connector, GOOGLE_CALENDAR_CONNECTOR_ID, source, "backfill");
                if (edited) {
                    expect(resumed.errors.join(" ")).toContain("snapshot_gap_unresolved");
                    expect(resumed.stored).toBe(0);
                    expect(resumed.duplicates).toBe(0);
                    expect(getCheckpoint(db, GOOGLE_CALENDAR_CONNECTOR_ID, source)?.cursor ?? null).toBeNull();
                    expect(db.query("SELECT * FROM events ORDER BY event_id").all()).toEqual(before);
                    expect((await runToCompletion(db, connector, GOOGLE_CALENDAR_CONNECTOR_ID, source, "backfill")).errors.join(" ")).toContain("snapshot_gap_unresolved");
                }
                else {
                    expect(resumed.errors).toEqual([]);
                    expect(resumed.stored).toBe(boundary === "before-accept" ? 2 : 0);
                    expect(resumed.duplicates).toBe(boundary === "after-accept" ? 2 : 0);
                    expect(db.query("SELECT * FROM events").all()).toHaveLength(2);
                    if (boundary === "after-accept")
                        expect(db.query("SELECT * FROM events ORDER BY event_id").all()).toEqual(before);
                }
            }
            finally {
                db.close();
                rmSync(root, { recursive: true, force: true });
            }
        });
    }
}
test('native grant denial and revocation stop provider acquisition and retain source attribution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'calendar-grant-')), db = openLedger(join(root, 'ledger.db'));
    try {
        const fixture = new CalendarFixture(), store = new ConnectionStateStore(root), pending = store.begin();
        await pending.writer.write(fixture.state);
        const connection = store.save(db, GOOGLE_CALENDAR_CONNECTOR_ID, pending.pending), source = connection.source_key;
        const handle = createStatePersister(db, store, connection), connector = await fixture.connected(async (bytes) => { await handle.persist(bytes); fixture.state = bytes; });
        const calls = fixture.calls.length;
        const denied = await runToCompletion(db, connector, GOOGLE_CALENDAR_CONNECTOR_ID, source, 'backfill');
        expect(denied.errors.length).toBeGreaterThan(0);
        expect(fixture.calls).toHaveLength(calls);
        setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: 'synthetic-calendar-consent', policy: { purposes: ['capture'], allowed_fields: ['text', 'subjects', 'attachments', 'metadata'], retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private' } });
        expect((await runToCompletion(db, connector, GOOGLE_CALENDAR_CONNECTOR_ID, source, 'backfill')).stored).toBe(2);
        expect(db.query('SELECT source_key FROM source_event_bindings').all()).toEqual([{ source_key: source }, { source_key: source }]);
        const { revokeSourceGrant } = await import('@kizuki/core');
        revokeSourceGrant(db, { source_key: source, expected_revision: 1, operation_id: 'synthetic-calendar-revoke' });
        const before = fixture.calls.length, checkpoint = getCheckpoint(db, GOOGLE_CALENDAR_CONNECTOR_ID, source)!.cursor;
        const stopped = await runToCompletion(db, connector, GOOGLE_CALENDAR_CONNECTOR_ID, source, 'sync');
        expect(stopped.errors.length).toBeGreaterThan(0);
        expect(fixture.calls).toHaveLength(before);
        expect(getCheckpoint(db, GOOGLE_CALENDAR_CONNECTOR_ID, source)!.cursor).toBe(checkpoint);
    }
    finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
    }
});
for (const otherAccount of [false, true])
    test(`late rotation cannot overwrite native CAS ${otherAccount ? 'different-account' : 'same-account'} replacement`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'calendar-rotation-cas-')), db = openLedger(join(root, 'ledger.db'));
        try {
            const { createGoogleCalendarConnector, GOOGLE_CALENDAR_SCOPES } = await import('../src');
            const { parseState, encodeState, FIELDS } = await import('../src/state');
            const f = new CalendarFixture(), old = parseState(f.state);
            old.oauth.tokens.expires_at = '2020-01-01T00:00:00Z';
            f.state = encodeState(old);
            const store = new ConnectionStateStore(root), pending = store.begin();
            await pending.writer.write(f.state);
            const connection = store.save(db, GOOGLE_CALENDAR_CONNECTOR_ID, pending.pending), handle = createStatePersister(db, store, connection);
            let entered!: () => void, release!: (value: any) => void;
            const started = new Promise<void>(resolve => { entered = resolve; });
            const c = createGoogleCalendarConnector({ client: { id: 'synthetic' }, secret_ref: connection.secret_refs[0]!, calendar_id: f.calendar, fields: FIELDS }, { fetch: f.fetch, now: f.now, persist: handle.persist, oauth: { listen: async () => { throw Error('unused'); }, postForm: async () => new Promise(resolve => { release = resolve; entered(); }) } });
            const connecting = c.connect(async () => new TextDecoder().decode(store.read(connection)!));
            const failure = connecting.catch(() => { });
            await started;
            const replacement = parseState(f.state);
            if (otherAccount)
                replacement.oauth.account.id = 'synthetic-replacement-account';
            replacement.oauth.tokens.access_token = 'synthetic-owner-new-access';
            replacement.oauth.tokens.refresh_token = 'synthetic-owner-new-refresh';
            replacement.oauth.tokens.expires_at = '2099-01-01T00:00:00Z';
            const newer = await store.rewrite(db, connection, writer => writer.write(encodeState(replacement)));
            const authoritative = store.read(newer)!;
            release({ status: 200, body: { access_token: 'synthetic-old-late-access', refresh_token: 'synthetic-old-late-refresh', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.join(' '), token_type: 'Bearer' } });
            await failure;
            expect(store.read(newer)).toEqual(authoritative);
            expect(parseState(store.read(newer)!).oauth.tokens.refresh_token).toBe('synthetic-owner-new-refresh');
            await expect(c.backfill(null)).rejects.toThrow();
        }
        finally {
            db.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
test('native late rotation survives reopen and later token expiry without losing page witness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'calendar-rotation-reopen-')), database = join(root, 'ledger.db');
    let db = openLedger(database);
    try {
        const { createGoogleCalendarConnector, GOOGLE_CALENDAR_SCOPES } = await import('../src');
        const { parseState, encodeState, FIELDS } = await import('../src/state');
        const f = new CalendarFixture();
        await (await f.connected()).backfill(null);
        const state = parseState(f.state), witness = state.pending;
        state.oauth.tokens.expires_at = '2020-01-01T00:00:00Z';
        f.state = encodeState(state);
        let store = new ConnectionStateStore(root);
        const pending = store.begin();
        await pending.writer.write(f.state);
        let connection = store.save(db, GOOGLE_CALENDAR_CONNECTOR_ID, pending.pending), handle = createStatePersister(db, store, connection);
        let entered!: () => void, release!: (value: any) => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const config = { client: { id: 'synthetic' }, secret_ref: connection.secret_refs[0]!, calendar_id: f.calendar, fields: FIELDS };
        const c = createGoogleCalendarConnector(config, { fetch: f.fetch, now: f.now, persist: handle.persist, oauth: { listen: async () => { throw Error('unused'); }, postForm: async () => new Promise(resolve => { release = resolve; entered(); }) } });
        const connecting = c.connect(async () => new TextDecoder().decode(store.read(connection)!));
        const refusal = connecting.catch(() => { });
        await started;
        await c.revoke();
        release({ status: 200, body: { access_token: 'synthetic-custody-access', refresh_token: 'synthetic-custody-refresh', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.join(' '), token_type: 'Bearer' } });
        await refusal;
        expect(parseState(store.read(handle.current())!).pending).toEqual(witness);
        expect(parseState(store.read(handle.current())!).oauth.tokens.refresh_token).toBe('synthetic-custody-refresh');
        const source = connection.source_key;
        db.close();
        db = openLedger(database);
        store = new ConnectionStateStore(root);
        expect(store.recover(db).unresolved).toEqual([]);
        connection = getConnection(db, GOOGLE_CALENDAR_CONNECTOR_ID, source)!;
        handle = createStatePersister(db, store, connection);
        f.advance();
        let refreshed = 0;
        const reopened = createGoogleCalendarConnector(config, { fetch: f.fetch, now: f.now, persist: handle.persist, oauth: { listen: async () => { throw Error('unused'); }, postForm: async (_url, form) => { expect(form.refresh_token).toBe('synthetic-custody-refresh'); refreshed++; return { status: 200, body: { access_token: 'synthetic-reopened-access', refresh_token: 'synthetic-reopened-refresh', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.join(' '), token_type: 'Bearer' } }; } } });
        await reopened.connect(async () => new TextDecoder().decode(store.read(connection)!));
        expect(refreshed).toBe(1);
        expect((await reopened.backfill(null)).events).toHaveLength(2);
        expect(parseState(store.read(handle.current())!).pending).toEqual(witness);
        await expect(c.backfill(null)).rejects.toThrow();
    }
    finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
    }
});
