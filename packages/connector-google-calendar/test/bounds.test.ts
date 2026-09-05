import { expect, test } from 'bun:test';
import { CalendarFixture } from '../src/testing';
import { createGoogleCalendarConnector } from '../src';
import { parseState, encodeState, FIELDS, digest, encodeCursor } from '../src/state';
import { runConformance } from '../../connectors/src/conformance';
test('native connector conformance including explicit tombstone', async () => {
    const f = new CalendarFixture(), c = await f.connected();
    const report = await runConformance(c, { unavailable: { connector: createGoogleCalendarConnector({}) }, tombstone: { prepare: async () => encodeCursor(parseState(f.state).pending!.next), mutate: async () => { f.rows = [{ id: 'allday1', status: 'cancelled' }]; f.version++; } } });
    expect(report).toEqual({ pass: true, failures: [] });
});
test('multiple pages have bounded cursors and final sync has no inferred deletion', async () => {
    const f = new CalendarFixture();
    f.rows = Array.from({ length: 45 }, (_, i) => ({ ...f.rows[0], id: `event${i}` }));
    const c = await f.connected();
    let cursor: string | null = null;
    let total = 0;
    for (let i = 0; i < 3; i++) {
        const b = await c.backfill(cursor);
        expect(b.status).toBeUndefined();
        expect(b.events.length).toBeLessThanOrEqual(20);
        expect(Buffer.byteLength(b.cursor!)).toBeLessThanOrEqual(8192);
        cursor = b.cursor;
        total += b.events.length;
    }
    expect(total).toBe(45);
    expect((await c.sync(cursor)).events).toEqual([]);
});
test('anchor capacity refuses without overwriting durable plan or checkpoint', async () => {
    const f = new CalendarFixture(), s = parseState(f.state);
    for (let i = 0; i < 1000; i++)
        s.anchors[digest(i)] = '2024-01-01T00:00:00Z';
    f.state = encodeState(s);
    f.rows = [{ id: 'newcancel', status: 'cancelled' }];
    const before = f.state.slice();
    const b = await (await f.connected()).backfill(null);
    expect(b.status).toBe('unavailable');
    expect(b.detail).toContain('cancellation_anchor_capacity');
    expect(b.cursor).toBeNull();
    expect(f.state).toEqual(before);
});
test('initial scan capacity is explicit and retains previous cursor', async () => {
    const f = new CalendarFixture();
    f.rows = Array.from({ length: 1001 }, (_, i) => ({ ...f.rows[0], id: `event${i}` }));
    const c = await f.connected();
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
        const b = await c.backfill(cursor);
        expect(b.events).toHaveLength(20);
        cursor = b.cursor;
    }
    const saved = f.state.slice(), b = await c.backfill(cursor);
    expect(b.detail).toContain('initial_scan_capacity');
    expect(b.cursor).toBe(cursor);
    expect(b.events).toEqual([]);
    expect(f.state).toEqual(saved);
});
test('cooldown is durable and refuses reopened transport until expiry', async () => {
    const f = new CalendarFixture(), c = await f.connected();
    f.failStatus = 429;
    const b = await c.backfill(null);
    expect(b.status).toBe('unavailable');
    expect(b.detail).toContain('rate_limited');
    expect(b.detail).not.toContain('PRIVATE_PROVIDER_SECRET');
    const before = f.calls.length;
    await expect(f.connected()).rejects.toThrow('rate_limited');
    expect(f.calls).toHaveLength(before);
    f.failStatus = 0;
    f.advance();
    expect((await (await f.connected()).backfill(null)).events).toHaveLength(2);
});
test('provider projection excludes unselected content and preserves metadata-only event', async () => {
    const f = new CalendarFixture(), s = parseState(f.state);
    s.fields = [];
    f.state = encodeState(s);
    const c = createGoogleCalendarConnector({ client: { id: 'synthetic-client' }, secret_ref: 'file:synthetic', calendar_id: f.calendar, fields: [] }, { fetch: f.fetch, persist: f.persist, now: f.now });
    await c.connect(async () => new TextDecoder().decode(f.state));
    const b = await c.backfill(null);
    expect(b.events[0]!.text).toBe('');
    const projection = new URL(f.calls.at(-1)!).searchParams.get('fields')!;
    for (const field of FIELDS)
        expect(projection).not.toContain(field);
    expect(projection).toContain('updated');
});
test('live observation clears prior cancellation anchor for a later explicit cancellation', async () => {
    const f = new CalendarFixture();
    const live = f.rows[0]!;
    f.rows = [{ id: live.id, status: 'cancelled' }];
    const c = await f.connected(), first = await c.backfill(null);
    f.advance();
    f.rows = [live];
    f.version++;
    const restored = await c.sync(first.cursor);
    expect(restored.events[0]!.deleted).not.toBe(true);
    f.advance();
    f.rows = [{ id: live.id, status: 'cancelled' }];
    f.version++;
    const again = await c.sync(restored.cursor);
    expect(again.events[0]!.occurred_at).not.toBe(first.events[0]!.occurred_at);
});
