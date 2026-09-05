import { test, expect } from 'bun:test';
import { WhoopFixture } from '../src/testing';
import { encodeState, parseState, scopes } from '../src/state';
test('timed-out refresh remains fenced through late rotation and pending host write', async () => {
    const f = new WhoopFixture(1), old = parseState(f.state);
    old.oauth.tokens.expires_at = '2020-01-01T00:00:00Z';
    f.state = encodeState(old);
    let release!: (value: any) => void, finishWrite!: () => void, writes = 0;
    const port = await f.connected({
        persist: async bytes => { writes++; await new Promise<void>(r => { finishWrite = r; }); await f.persist(bytes); },
        oauth: { listen: async () => { throw Error('not enrollment'); }, postForm: async () => new Promise(r => { release = r; }) }
    });
    const start = Date.now(), result = await port.sync(null);
    expect(Date.now() - start).toBeLessThan(6500);
    expect(result.status).toBe('unavailable');
    expect(result.detail).toContain('timeout');
    let reads = 0;
    const resolve = async () => { reads++; return new TextDecoder().decode(f.state); };
    await expect(port.connect(resolve)).rejects.toThrow();
    await expect(port.sync(null)).rejects.toThrow();
    release({ status: 200, body: { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, scope: scopes(f.selection).join(' '), token_type: 'Bearer' } });
    await Bun.sleep(10);
    expect(writes).toBe(1);
    await expect(port.connect(resolve)).rejects.toThrow();
    await expect(port.sync(null)).rejects.toThrow();
    expect(reads).toBe(0);
    finishWrite();
    await Bun.sleep(10);
    expect(parseState(f.state).oauth.tokens.refresh_token).toBe('rotated-refresh');
    await port.connect(resolve);
    expect(reads).toBe(1);
    await port.close();
}, 10000);
test('uncertain host persistence is bounded, fences reload until settlement and retains original checkpoint', async () => {
    const f = new WhoopFixture();
    let release!: () => void, held = true, calls = 0, resolves = 0;
    const port = await f.connected({
        persist: async (b) => {
            calls++;
            if (held)
                await new Promise<void>(r => {
                    release = r;
                });
            await f.persist(b);
        }
    });
    const start = Date.now(), result = await port.sync(null);
    expect(Date.now() - start).toBeLessThan(6500);
    expect(result.status).toBe('unavailable');
    expect(result.cursor).toBeNull();
    expect(result.events).toEqual([]);
    expect(result.detail).toContain('timeout');
    await expect(port.connect(async () => {
        resolves++;
        return new TextDecoder().decode(f.state);
    })).rejects.toThrow();
    expect(resolves).toBe(0);
    expect(calls).toBe(1);
    held = false;
    release();
    await Bun.sleep(25);
    await port.connect(async () => new TextDecoder().decode(f.state));
    expect((await port.sync(null)).events).toHaveLength(2);
    await port.close();
}, 10000);
test('scopes, account and selection cannot be silently widened when importing protected state', async () => {
    const f = new WhoopFixture(), bad = parseState(f.state);
    bad.oauth.tokens.scope = 'offline read:profile';
    const bytes = new TextEncoder().encode(JSON.stringify(bad));
    f.state = bytes;
    await expect(f.connected()).rejects.toThrow();
    const g = new WhoopFixture();
    g.account = 8;
    const port = await g.connected();
    const refused = await port.sync(null);
    expect(refused.status).toBe('unavailable');
    expect(refused.detail).toContain('identity_mismatch');
    expect(refused.events).toEqual([]);
    await port.close();
});
test('late protected-state load cannot alter newer session health or account', async () => {
    const f = new WhoopFixture();
    const port = await f.connected();
    let release!: (s: string) => void;
    const old = port.connect(async () => new Promise<string>(r => {
        release = r;
    }));
    await port.connect(async () => new TextDecoder().decode(f.state));
    release('malformed-old-state');
    await expect(old).rejects.toThrow();
    expect((await port.health()).state).toBe('degraded');
    expect((await port.sync(null)).events).toHaveLength(2);
    await port.close();
});
test('missing protected state refuses without provider requests', async () => {
    const f = new WhoopFixture(), port = await f.connected();
    await expect(port.connect(async () => {
        throw Error('synthetic-private-path');
    })).rejects.toThrow('unauthenticated');
    expect(f.requests).toHaveLength(0);
    await port.close();
});
test('refresh and API requests share one operation budget', async () => {
    const f = new WhoopFixture(1000);
    const old = parseState(f.state);
    old.oauth.tokens.expires_at = '2020-01-01T00:00:00Z';
    f.state = encodeState(old);
    let tokenCalls = 0;
    const port = await f.connected({
        oauth: {
            listen: async () => {
                throw Error('not enrollment');
            }, postForm: async () => {
                tokenCalls++;
                return {
                    status: 200, body: {
                        access_token: 'synthetic-brief-access', refresh_token: 'synthetic-brief-refresh', expires_in: 1, scope: scopes(f.selection).join(' '), token_type: 'Bearer'
                    }
                };
            }
        }
    });
    const result = await port.backfill(null);
    expect(result.status).toBe('unavailable');
    expect(result.events).toEqual([]);
    expect(tokenCalls + f.requests.length).toBeLessThanOrEqual(48);
    await port.close();
});

test('instance manifest declares state custody and health recovers persisted cooldown', async () => {
    const f = new WhoopFixture();
    let port = await f.connected();
    expect(port.manifest().required_secrets).toEqual(['file:/synthetic-protected-state']);
    f.failStatus = 429;
    await port.sync(null);
    await port.close();
    port = await f.connected();
    expect((await port.health()).state).toBe('rate_limited');
    await port.close();
});
