import { expect, test } from 'bun:test';
import { validateEventInput } from '@kizuki/core';
import { WhoopFixture } from '../src/testing';
import { encodeState, parseState, scopes } from '../src/state';

test('collection window, newest-first listing and revision time stay distinct', async () => {
    const f = new WhoopFixture(4, {
        resources: ['cycle'], fields: ['metrics', 'activity'], history_start: '2026-01-01T00:00:00Z'
    });
    Object.assign(f.records.cycle[0]!, {
        start: '2025-12-01T00:00:00Z', end: '2025-12-01T08:00:00Z', timezone_offset: '+00:00', patient_email: 'discard@example.test'
    });
    Object.assign(f.records.cycle[1]!, {
        start: '2026-01-10T08:00:00-08:00', end: '2026-01-10T09:00:00-08:00', timezone_offset: '-08:00', updated_at: '2026-01-22T00:00:00Z'
    });
    Object.assign(f.records.cycle[2]!, {
        start: '2026-01-15T08:00:00-08:00', end: '2026-01-15T09:00:00-08:00', timezone_offset: '-08:00', updated_at: '2026-01-20T12:00:00Z', patient_email: 'discard@example.test'
    });
    Object.assign(f.records.cycle[3]!, {
        start: '2026-02-01T00:00:00Z', end: '2026-02-01T01:00:00Z', timezone_offset: 'Z'
    });
    const port = await f.connected();
    const batch = await port.backfill(null);
    expect(batch.status).toBeUndefined();
    expect(batch.events.map(e => e.source_record_id)).toEqual(['whoop:7:cycle:2', 'whoop:7:cycle:3']);
    expect(batch.events.every(e => validateEventInput(e).ok)).toBe(true);
    expect(batch.events.map(e => e.occurred_at)).toEqual(['2026-01-22T00:00:00Z', '2026-01-20T12:00:00Z']);
    expect(batch.events[0]!.occurred_at).not.toBe('2026-01-10T08:00:00-08:00');
    expect(batch.events[1]!.metadata).not.toHaveProperty('patient_email');
    expect(batch.events[1]!.metadata.activity).toEqual({
        start: '2026-01-15T08:00:00-08:00', end: '2026-01-15T09:00:00-08:00', timezone_offset: '-08:00'
    });
    expect(JSON.stringify([batch, await port.health(), batch.cursor])).not.toContain('discard@example.test');
    const pages = f.requests.filter(r => !r.url.includes('/user/'));
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.every(r => {
        const q = new URL(r.url).searchParams;
        return q.get('start') === f.selection.history_start && q.get('end') === '2026-02-01T00:00:00.000Z' && q.get('limit') === '25';
    })).toBe(true);
    expect(pages.some(r => new URL(r.url).searchParams.has('nextToken'))).toBe(false);
    await port.close();
});

test('a page over the v2 limit refuses without emitting a prefix', async () => {
    const f = new WhoopFixture(1);
    const template = f.records.cycle[0]!;
    const port = await f.connected({
        fetch: async (request) => request.url.includes('/user/') ? Response.json({ user_id: 7 }) : Response.json({
            records: Array.from({ length: 26 }, (_, i) => ({
                ...template, id: i + 1
            })), next_token: null
        })
    });
    const refused = await port.backfill(null);
    expect(refused.status).toBe('unavailable');
    expect(refused.events).toEqual([]);
    expect(refused.cursor).toBeNull();
    expect(parseState(f.state).pending).toBeNull();
    await port.close();
});

test('rotated tokens persist before use and a failed write fences without capture', async () => {
    for (const reject of [false, true]) {
        const f = new WhoopFixture(1), old = parseState(f.state);
        old.oauth.tokens.expires_at = '2020-01-01T00:00:00Z';
        f.state = encodeState(old);
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>(r => {
            entered = r;
        }), held = new Promise<void>(r => {
            release = r;
        });
        let gate = false;
        const port = await f.connected({
            persist: async bytes => {
                if (gate) {
                    entered();
                    await held;
                    if (reject)
                        throw Error('SYNTHETIC_PERSIST_CANARY');
                }
                await f.persist(bytes);
            },
            oauth: {
                listen: async () => {
                    throw Error('not enrollment');
                }, postForm: async () => ({
                    status: 200, body: {
                        access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, scope: scopes(f.selection).join(' '), token_type: 'Bearer'
                    }
                })
            }
        });
        gate = true;
        const running = port.backfill(null);
        await started;
        expect(f.requests).toHaveLength(0);
        release();
        const result = await running;
        if (reject) {
            expect(result.status).toBe('unavailable');
            expect(result.events).toEqual([]);
            expect(result.cursor).toBeNull();
            expect(result.detail).not.toContain('SYNTHETIC_PERSIST_CANARY');
            expect(result.detail).not.toContain('rotated-refresh');
            expect(f.requests).toHaveLength(0);
            expect(parseState(f.state).oauth.tokens.refresh_token).toBe('synthetic-whoop-refresh');
            expect((await port.sync(null)).status).toBe('unavailable');
        }
        else {
            expect(result.status).toBeUndefined();
            expect(result.events).toHaveLength(1);
            expect(parseState(f.state).oauth.tokens.refresh_token).toBe('rotated-refresh');
            expect(f.requests[0]!.headers.get('authorization')).toBe('Bearer rotated-access');
        }
        await port.close();
    }
});

test('provider, profile and token canaries never appear on capture surfaces', async () => {
    const f = new WhoopFixture(1);
    const port = await f.connected();
    const batch = await port.sync(null);
    expect(batch.status).toBeUndefined();
    const ok = JSON.stringify([batch, await port.health(), batch.cursor, port.manifest()]);
    for (const canary of ['never-emit', 'discard@example.test', 'Discard', 'synthetic-whoop-access', 'synthetic-whoop-refresh', 'synthetic-app-secret'])
        expect(ok).not.toContain(canary);
    f.failStatus = 429;
    const limited = await port.sync(batch.cursor);
    expect(limited.status).toBe('unavailable');
    expect(limited.detail).toContain('rate_limited');
    const cooled = JSON.stringify([limited, await port.health(), parseState(f.state).retry_at]);
    for (const canary of ['never-emit', 'discard@example.test', 'synthetic-whoop-access', 'synthetic-whoop-refresh'])
        expect(cooled).not.toContain(canary);
    await port.close();
});

test('disappearance is not a tombstone and unchanged rescan does not report ok completeness', async () => {
    const f = new WhoopFixture();
    const port = await f.connected();
    const first = await port.backfill(null);
    expect(first.status).toBeUndefined();
    expect(first.events).toHaveLength(2);
    expect(first.detail).toContain('non_atomic_listing');
    expect(first.detail).toContain('polling_deletions_unavailable');
    expect((await port.health()).state).toBe('degraded');
    const unchanged = await port.sync(first.cursor);
    expect(unchanged.status).toBeUndefined();
    expect(unchanged.events).toEqual([]);
    expect(unchanged.cursor).toBe(first.cursor);
    expect(unchanged.detail).toContain('polling_deletions_unavailable');
    expect((await port.health()).state).not.toBe('ok');
    f.records.cycle.pop();
    const reduced = await port.sync(first.cursor);
    expect(reduced.status).toBeUndefined();
    expect(reduced.events.length).toBeGreaterThan(0);
    expect(reduced.events.every(e => e.deleted === false)).toBe(true);
    expect(reduced.detail).toContain('polling_deletions_unavailable');
    await port.close();
});
