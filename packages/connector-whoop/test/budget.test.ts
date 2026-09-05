import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { WhoopFixture } from '../src/testing';
import { encodeState, parseState, scopes } from '../src/state';

test('48 charged requests refuse the next expired-token exchange and retain the live session for a new budget', async () => {
    const fixture = new WhoopFixture(600), state = parseState(fixture.state);
    state.oauth.tokens.expires_at = '2020-01-01T00:00:00Z';
    fixture.state = encodeState(state);
    let tokenRequests = 0, writes = 0;
    const port = await fixture.connected({
        persist: async bytes => { writes++; await fixture.persist(bytes); },
        oauth: {
            listen: async () => { throw Error('not enrollment'); },
            postForm: async () => {
                tokenRequests++;
                return { status: 200, body: { access_token: `synthetic-access-${tokenRequests}`, refresh_token: `synthetic-refresh-${tokenRequests}`, expires_in: 1, scope: scopes(fixture.selection).join(' '), token_type: 'Bearer' } };
            },
        },
    });
    try {
        const result = await port.backfill(null);
        expect(result.status).toBe('unavailable');
        expect(result.detail).toContain('request_limit');
        expect(result.events).toHaveLength(0);
        expect(result.cursor).toBeNull();
        expect(fixture.requests).toHaveLength(24);
        expect(tokenRequests).toBe(24);
        expect(writes).toBe(24); // Only completed token rotations; no partial history checkpoint.
        expect((await port.health()).state).toBe('degraded');
        expect(parseState(fixture.state).pending).toBeNull();
        // A smaller replay fits a fresh operation budget without reconnecting or
        // rebuilding the session from disk. Its existing rotated token remains usable.
        fixture.records.cycle.splice(1);
        const retried = await port.backfill(null);
        expect(retried.status).toBeUndefined();
        expect(retried.events).toHaveLength(1);
        expect(tokenRequests).toBeGreaterThan(24);
    } finally { await port.close(); }
});

test('an authentication failure on the last permitted request retains its authentication diagnosis', async () => {
    const fixture = new WhoopFixture(600);
    // The first profile request uses a cached token. Each subsequent provider
    // request requires a refresh, putting the 24th refresh at charged request 48.
    fixture.before = async () => { fixture.time = new Date('2100-01-01T00:00:00Z'); };
    let tokenRequests = 0;
    const port = await fixture.connected({ oauth: {
        listen: async () => { throw Error('not enrollment'); },
        postForm: async () => {
            if (++tokenRequests === 24) return { status: 401, body: { error: 'invalid_grant' } };
            return { status: 200, body: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 1, scope: scopes(fixture.selection).join(' '), token_type: 'Bearer' } };
        },
    } });
    try {
        const result = await port.backfill(null);
        expect(tokenRequests).toBe(24);
        expect(fixture.requests).toHaveLength(24);
        expect(result.detail).toContain('unauthenticated');
        expect(result.detail).not.toContain('request_limit');
        expect((await port.health()).state).toBe('unauthenticated');
    } finally { await port.close(); }
});
test('deadline expiry between WHOOP requests refuses token work without unhandled rejection and permits durable reload', () => {
    const child = Bun.spawnSync([process.execPath, fileURLToPath(new URL('./budget-child.ts', import.meta.url))], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    expect(child.exitCode).toBe(0);
    expect(new TextDecoder().decode(child.stderr)).toBe('');
    const receipt = JSON.parse(new TextDecoder().decode(child.stdout));
    expect(receipt.first.unhandled).toBe(0);
    expect(receipt.first.status).toBe('unavailable');
    expect(receipt.first.detail).toContain('timeout');
    expect(receipt.first.events).toBe(0);
    expect(receipt.first.cursor).toBeNull();
    expect(receipt.first.providerCalls).toBe(1);
    expect(receipt.first.tokenCalls).toBe(0);
    expect(receipt.first.writes).toBe(0);
    expect(receipt.first.unchangedState).toBe(true);
    expect(receipt.recovered.status).toBeUndefined();
    expect(receipt.recovered.events).toBe(1);
});
