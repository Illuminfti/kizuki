import { test, expect } from 'bun:test';
import { WhoopFixture } from '../src/testing';
import { parseState } from '../src/state';
import { runConformance } from '../../connectors/src/conformance';
test('selected resources use exact scopes and fixed v2 pagination; completed rescan finds old edits', async () => {
    const f = new WhoopFixture(26, {
        resources: ['cycle', 'recovery', 'sleep', 'workout'], fields: ['metrics', 'activity'], history_start: '2026-01-01T00:00:00Z'
    });
    let port = await f.connected();
    let cursor: string | null = null;
    let count = 0;
    for (let n = 0; n < 6; n++) {
        const batch = await port.backfill(cursor);
        expect(batch.status).toBeUndefined();
        count += batch.events.length;
        cursor = batch.cursor;
        if (batch.events.length === 0)
            break;
    }
    expect(count).toBe(104);
    expect(f.requests.every(r => new URL(r.url).origin === 'https://api.prod.whoop.com')).toBe(true);
    expect(f.requests.some(r => new URL(r.url).searchParams.get('nextToken') === '25')).toBe(true);
    await port.close();
    port = await f.connected();
    f.records.cycle[0]!.score = {
        strain: 9
    };
    f.records.cycle[0]!.updated_at = '2026-01-30T00:00:00Z';
    f.time = new Date('2026-02-02T00:00:00Z');
    const edited = await port.sync(cursor);
    expect(edited.status).toBeUndefined();
    expect(edited.events.some(e => e.text.includes('"strain":9'))).toBe(true);
    expect(edited.detail).toContain('polling_deletions_unavailable');
    await port.close();
});
test('durable witness precedes first yield, exact restart replay, changed retry refuses original cursor', async () => {
    const f = new WhoopFixture(26);
    let port = await f.connected();
    const first = await port.backfill(null);
    expect(first.events).toHaveLength(25);
    expect(parseState(f.state).pending!.issued).toBe(25);
    expect(new TextDecoder().decode(f.state)).not.toContain('Reported measurements');
    await port.close();
    port = await f.connected();
    expect(await port.backfill(null)).toEqual(first);
    const tail = await port.backfill(first.cursor);
    expect(tail.events).toHaveLength(1);
    f.records.cycle[25]!.score = {
        strain: 999
    };
    const changed = await port.backfill(first.cursor);
    expect(changed.status).toBe('unavailable');
    expect(changed.cursor).toBe(first.cursor);
    expect(changed.events).toEqual([]);
    expect(changed.detail).toContain('snapshot_gap_unresolved');
    await port.close();
});
test('list disappearance and HTTP404 never infer deletion; malformed/future checkpoints refuse', async () => {
    const f = new WhoopFixture();
    const port = await f.connected();
    const batch = await port.backfill(null);
    f.records.cycle.pop();
    const reduced = await port.sync(batch.cursor);
    expect(reduced.events.every(e => !e.deleted)).toBe(true);
    f.failStatus = 404;
    const missing = await port.sync(reduced.cursor);
    expect(missing.status).toBe('unavailable');
    expect(missing.cursor).toBe(reduced.cursor);
    f.failStatus = 0;
    const forged = JSON.stringify({
        ...JSON.parse(reduced.cursor!), offset: 999
    });
    expect((await port.sync(forged)).status).toBe('unavailable');
    await expect(port.sync('not-json')).rejects.toThrow();
    await port.close();
});
test('rate-limit cooldown is durable across restart and provider authorization revoke is distinct from local close', async () => {
    const f = new WhoopFixture();
    let port = await f.connected();
    f.failStatus = 429;
    const refused = await port.sync(null);
    expect(refused.status).toBe('unavailable');
    expect(refused.detail).toContain('rate_limited');
    expect(parseState(f.state).retry_at).not.toBeNull();
    await port.close();
    port = await f.connected();
    const count = f.requests.length;
    await port.sync(null);
    expect(f.requests).toHaveLength(count);
    f.failStatus = 0;
    f.time = new Date(f.time.getTime() + 61000);
    await port.revoke();
    expect(f.requests.at(-1)!.method).toBe('DELETE');
    expect((await port.health()).state).toBe('disabled');
    await expect(port.sync(null)).rejects.toThrow();
    const g = new WhoopFixture();
    const other = await g.connected();
    g.failStatus = 500;
    await expect(other.revoke()).rejects.toThrow();
    expect((await other.health()).state).not.toBe('disabled');
    const before = g.requests.length;
    await other.close();
    expect(g.requests).toHaveLength(before);
});
test('over-limit initial history and cyclic page tokens do not emit partial history or advance', async () => {
    const f = new WhoopFixture(1001);
    const port = await f.connected();
    const refused = await port.backfill(null);
    expect(refused.status).toBe('unavailable');
    expect(refused.cursor).toBeNull();
    expect(refused.events).toEqual([]);
    expect(refused.detail).toContain('history_limit');
    expect(parseState(f.state).pending).toBeNull();
    await port.close();
    const g = new WhoopFixture();
    const cycle = await g.connected({
        fetch: async (r) => r.url.includes('/user/') ? Response.json({
            user_id: 7
        }) : Response.json({
            records: [], next_token: 'repeat'
        })
    });
    expect((await cycle.sync(null)).detail).toContain('pagination_gap');
    await cycle.close();
});
test('shared conformance runs against offline provider fixture with no interactive auth claim', async () => {
    const f = new WhoopFixture();
    const port = await f.connected();
    const result = await runConformance(port, {
        backfillTwice: true
    });
    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
});
test('provider revoke owns the session operation while pending and local close never revokes remotely', async () => {
    const f = new WhoopFixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => {
        entered = r;
    }), held = new Promise<void>(r => {
        release = r;
    });
    f.before = async (r) => {
        if (r.method === 'DELETE') {
            entered();
            await held;
        }
    };
    const port = await f.connected();
    const revoking = port.revoke();
    await started;
    await expect(port.sync(null)).rejects.toThrow('unavailable');
    release();
    await revoking;
    expect((await port.health()).state).toBe('disabled');
});
test('long explicit provider cooldown is never shortened to a local monthly cap', async () => {
    const f = new WhoopFixture();
    f.failStatus = 429;
    f.retry = '3000000';
    const port = await f.connected();
    await port.sync(null);
    expect(Date.parse(parseState(f.state).retry_at!) - f.time.getTime()).toBe(3000000000);
    await port.close();
});
