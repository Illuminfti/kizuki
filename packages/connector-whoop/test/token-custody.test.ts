import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionStateStore, createStatePersister, getConnection, openLedger } from '@kizuki/core';
import { WhoopFixture } from '../src/testing';
import { WHOOP_ID, encodeState, parseState, scopes } from '../src/state';

for (const replacement of ['none', 'same-account', 'different-account'] as const) {
    test(`late rotation uses original native CAS after close: ${replacement}`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'whoop-token-custody-'));
        let db = openLedger(join(root, 'ledger.db'));
        try {
            const f = new WhoopFixture(1), initial = parseState(f.state);
            initial.oauth.tokens.expires_at = '2026-02-01T01:00:00Z';
            f.state = encodeState(initial);
            let store = new ConnectionStateStore(root);
            const pending = store.begin();
            await pending.writer.write(f.state);
            const connection = store.save(db, WHOOP_ID, pending.pending);
            const handle = createStatePersister(db, store, connection);
            let release!: (value: any) => void, started!: () => void;
            const startedPromise = new Promise<void>(r => { started = r; });
            let failures = 0;
            const port = await f.connected({
                persist: async bytes => {
                    try { await handle.persist(bytes); await f.persist(bytes); }
                    catch (error) { failures++; throw error; }
                },
                oauth: { listen: async () => { throw Error('not enrollment'); }, postForm: async () => new Promise(r => { release = r; started(); }) }
            });
            const first = await port.sync(null);
            expect(first.status).toBeUndefined();
            const savedPlan = parseState(f.state).pending;
            expect(savedPlan).not.toBeNull();
            f.time = new Date('2026-02-01T02:00:00Z');
            const running = port.sync(first.cursor);
            await startedPromise;
            let replacements: Uint8Array | null = null;
            if (replacement !== 'none') {
                const newer = parseState(f.state);
                newer.oauth.tokens.access_token = 'replacement-access';
                newer.oauth.tokens.refresh_token = 'replacement-refresh';
                if (replacement === 'different-account') { newer.oauth.account.id = '8'; newer.pending = null; }
                replacements = encodeState(newer);
                // A distinct host handle advances native state identity. The old
                // handle must fail, even for the same provider account.
                await createStatePersister(db, store, handle.current()).persist(replacements);
            }
            await port.close();
            release({ status: 200, body: { access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600, scope: scopes(f.selection).join(' '), token_type: 'Bearer' } });
            expect((await running).status).toBe('unavailable');
            await expect(port.sync(null)).rejects.toThrow();
            const durable = store.read(getConnection(db, WHOOP_ID, connection.source_key)!)!;
            if (replacements !== null) {
                expect(failures).toBe(1);
                expect(durable).toEqual(replacements);
            } else {
                expect(failures).toBe(0);
                expect(parseState(durable).oauth.tokens.refresh_token).toBe('late-refresh');
                expect(parseState(durable).pending).toEqual(savedPlan);
                db.close();
                db = openLedger(join(root, 'ledger.db'));
                store = new ConnectionStateStore(root);
                expect(store.recover(db).unresolved).toEqual([]);
                const reopened = getConnection(db, WHOOP_ID, connection.source_key)!;
                f.state = store.read(reopened)!;
                f.time = new Date('2026-02-01T04:00:00Z');
                let usedRefresh: string | undefined;
                const restarted = await f.connected({
                    persist: createStatePersister(db, store, reopened).persist,
                    oauth: { listen: async () => { throw Error('not enrollment'); }, postForm: async (_url, form) => {
                        usedRefresh = form.refresh_token;
                        return { status: 200, body: { access_token: 'restart-access', refresh_token: 'restart-refresh', expires_in: 3600, scope: scopes(f.selection).join(' '), token_type: 'Bearer' } };
                    } }
                });
                expect((await restarted.sync(first.cursor)).status).toBeUndefined();
                expect(usedRefresh).toBe('late-refresh');
                await restarted.close();
            }
        } finally {
            db.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
}
