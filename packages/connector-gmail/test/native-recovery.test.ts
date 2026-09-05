import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConnectionStateStore, createStatePersister, getConnection, getCheckpoint, openLedger, runToCompletion } from "@kizuki/core";
import { GMAIL_CONNECTOR_ID } from "../src/index";
import { GmailFixture } from "../src/testing";
test("native runToCompletion reopens persisted deletion observation after lost state-write response, before tombstone", async () => {
    const root = mkdtempSync(join(tmpdir(), "gmail-native-"));
    const database = join(root, "ledger.db");
    let db = openLedger(database);
    try {
        const fixture = new GmailFixture(1), store = new ConnectionStateStore(root);
        const enrollment = store.begin();
        await enrollment.writer.write(fixture.state);
        let connection = store.save(db, GMAIL_CONNECTOR_ID, enrollment.pending);
        const source = connection.source_key;
        let handle = createStatePersister(db, store, connection);
        let connector = await fixture.connected(async (bytes) => { await handle.persist(bytes); fixture.state = bytes; });
        const captured = await runToCompletion(db, connector, GMAIL_CONNECTOR_ID, source, "backfill");
        expect(captured.errors).toEqual([]);
        expect(captured.stored).toBe(1);
        const original = getCheckpoint(db, GMAIL_CONNECTOR_ID, source)!.cursor;
        fixture.advanceDay();
        fixture.change("m1", "messagesDeleted");
        connector = await fixture.connected(async (bytes) => { await handle.persist(bytes); throw new Error("synthetic lost state response"); });
        const interrupted = await runToCompletion(db, connector, GMAIL_CONNECTOR_ID, source, "sync");
        expect(interrupted.errors.length).toBeGreaterThan(0);
        expect(getCheckpoint(db, GMAIL_CONNECTOR_ID, source)!.cursor).toBe(original);
        const saved = store.read(handle.current())!;
        const observation = JSON.parse(new TextDecoder().decode(saved)).pending.observed_at;
        expect(new TextDecoder().decode(saved)).not.toContain("Synthetic message body");
        db.close();
        db = openLedger(database);
        const reopenedStore = new ConnectionStateStore(root);
        expect(reopenedStore.recover(db).unresolved).toEqual([]);
        connection = getConnection(db, GMAIL_CONNECTOR_ID, source)!;
        fixture.state = reopenedStore.read(connection)!;
        fixture.advanceDay();
        handle = createStatePersister(db, reopenedStore, connection);
        connector = await fixture.connected(async (bytes) => { await handle.persist(bytes); fixture.state = bytes; });
        const recovered = await runToCompletion(db, connector, GMAIL_CONNECTOR_ID, source, "sync");
        expect(recovered.errors).toEqual([]);
        expect(recovered.stored).toBe(1);
        const rows = db.query("SELECT occurred_at, observed_at, metadata FROM events WHERE deleted=1").all() as Record<string, unknown>[];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.occurred_at).toBe(observation);
        expect(rows[0]!.observed_at).toBe(observation);
        expect(JSON.parse(rows[0]!.metadata as string).provider_deleted_at).toBeNull();
        // Public replay from the actual durable checkpoint does not mint another deletion.
        const retried = await runToCompletion(db, connector, GMAIL_CONNECTOR_ID, source, "sync");
        expect(retried.errors).toEqual([]);
        expect(retried.stored).toBe(0);
    }
    finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
    }
});
