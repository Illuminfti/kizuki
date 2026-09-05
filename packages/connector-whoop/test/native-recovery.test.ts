import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionStateStore, createStatePersister, getConnection, getCheckpoint, openLedger, runToCompletion, setSourceGrant, replayLive } from '@kizuki/core';
import { WhoopFixture } from '../src/testing';
import { WHOOP_ID } from '../src/state';
for (const changed of [false, true])
    test(`actual ledger partial accept/restart ${changed ? 'refuses changed snapshot' : 'deduplicates exact witness'}`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'whoop-native-'));
        let db = openLedger(join(root, 'ledger.db'));
        try {
            const f = new WhoopFixture(26);
            let store = new ConnectionStateStore(root);
            const pending = store.begin();
            await pending.writer.write(f.state);
            let connection = store.save(db, WHOOP_ID, pending.pending);
            const source = connection.source_key;
            setSourceGrant(db, {
                source_key: source, expected_revision: 0, operation_id: 'synthetic-whoop-grant', policy: {
                    purposes: ['capture'], allowed_fields: ['text', 'subjects', 'attachments', 'metadata'], retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private'
                }
            });
            let handle = createStatePersister(db, store, connection);
            let port = await f.connected({
                persist: async (b) => {
                    await handle.persist(b);
                    await f.persist(b);
                }
            });
            const first = await runToCompletion(db, port, WHOOP_ID, source, 'backfill', {
                maxBatches: 1
            });
            expect(first.stored).toBe(25);
            const checkpoint = getCheckpoint(db, WHOOP_ID, source)!.cursor;
            await port.close();
            db.close();
            db = openLedger(join(root, 'ledger.db'));
            store = new ConnectionStateStore(root);
            expect(store.recover(db).unresolved).toEqual([]);
            connection = getConnection(db, WHOOP_ID, source)!;
            f.state = store.read(connection)!;
            handle = createStatePersister(db, store, connection);
            if (changed)
                f.records.cycle[0]!.score = {
                    strain: 900
                };
            port = await f.connected({
                persist: async (b) => {
                    await handle.persist(b);
                    await f.persist(b);
                }
            });
            const retry = await runToCompletion(db, port, WHOOP_ID, source, 'backfill');
            if (changed) {
                expect(retry.errors.length).toBeGreaterThan(0);
                expect(getCheckpoint(db, WHOOP_ID, source)!.cursor).toBe(checkpoint);
                expect([...replayLive(db)]).toHaveLength(25);
            }
            else {
                expect(retry.errors).toEqual([]);
                expect(retry.stored).toBe(1);
                expect([...replayLive(db)]).toHaveLength(26);
                expect((await runToCompletion(db, port, WHOOP_ID, source, 'sync')).stored).toBe(0);
            }
            await port.close();
        }
        finally {
            db.close();
            rmSync(root, {
                recursive: true, force: true
            });
        }
    });
test('actual child exit after durable witness before acceptance resumes without duplicate evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whoop-crash-'));
    let db = openLedger(join(root, 'ledger.db'));
    try {
        const f = new WhoopFixture(2), store = new ConnectionStateStore(root), pending = store.begin();
        await pending.writer.write(f.state);
        const connection = store.save(db, WHOOP_ID, pending.pending), source = connection.source_key;
        setSourceGrant(db, {
            source_key: source, expected_revision: 0, operation_id: 'synthetic-crash-grant', policy: {
                purposes: ['capture'], allowed_fields: ['text', 'subjects', 'attachments', 'metadata'], retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'private'
            }
        });
        db.close();
        const script = join(root, 'crash.ts');
        const { writeFileSync } = await import('node:fs');
        writeFileSync(script, `import {openLedger,ConnectionStateStore,getConnection,createStatePersister,runToCompletion} from ${JSON.stringify(join(import.meta.dir, '../../core/src/index.ts'))};import {WhoopFixture} from ${JSON.stringify(join(import.meta.dir, '../src/testing.ts'))};const db=openLedger(${JSON.stringify(join(root, 'ledger.db'))}),store=new ConnectionStateStore(${JSON.stringify(root)}),connection=getConnection(db,'kizuki.whoop',${JSON.stringify(source)}),handle=createStatePersister(db,store,connection),f=new WhoopFixture(2);f.state=store.read(connection);const port=await f.connected({persist:async bytes=>{await handle.persist(bytes);if(JSON.parse(new TextDecoder().decode(bytes)).pending?.issued>0)process.exit(17)}});await runToCompletion(db,port,'kizuki.whoop',${JSON.stringify(source)},'backfill');process.exit(19);`);
        const child = Bun.spawnSync([process.execPath, script], {
            stdout: 'pipe', stderr: 'pipe'
        });
        expect(child.exitCode, child.stderr.toString()).toBe(17);
        db = openLedger(join(root, 'ledger.db'));
        expect([...replayLive(db)]).toHaveLength(0);
        expect(getCheckpoint(db, WHOOP_ID, source)).toBeNull();
        expect(store.recover(db).unresolved).toEqual([]);
        const saved = getConnection(db, WHOOP_ID, source)!;
        f.state = store.read(saved)!;
        const handle = createStatePersister(db, store, saved), port = await f.connected({
            persist: async (b) => {
                await handle.persist(b);
                await f.persist(b);
            }
        });
        const result = await runToCompletion(db, port, WHOOP_ID, source, 'backfill');
        expect(result.errors).toEqual([]);
        expect(result.stored).toBe(2);
        await port.close();
    }
    finally {
        db.close();
        rmSync(root, {
            recursive: true, force: true
        });
    }
}, 10000);
