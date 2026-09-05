// Isolate the clock seam; all credentials, provider calls and state are synthetic.
import { WhoopFixture } from '../src/testing';
import { encodeState, parseState, scopes } from '../src/state';
const fixture = new WhoopFixture(1), state = parseState(fixture.state);
state.oauth.tokens.expires_at = '2020-01-01T00:00:00Z';
fixture.state = encodeState(state);
let tokenCalls = 0, writes = 0, unhandled = 0, originalRefreshUsed = false;
process.on('unhandledRejection', () => { unhandled++; });
const port = await fixture.connected({
    persist: async bytes => { writes++; await fixture.persist(bytes); },
    oauth: { listen: async () => { throw Error('not enrollment'); }, postForm: async (_url, form) => {
        tokenCalls++;
        originalRefreshUsed = form.refresh_token === state.oauth.tokens.refresh_token;
        return { status: 200, body: { access_token: 'synthetic-retry-access', refresh_token: 'synthetic-retry-refresh', expires_in: 3600, scope: scopes(fixture.selection).join(' '), token_type: 'Bearer' } };
    } },
});
const originalNow = Date.now;
let index = 0;
const readings = [0, 44_999, 45_000];
Date.now = () => readings[Math.min(index++, readings.length - 1)]!;
try {
    const originalState = Buffer.from(fixture.state).toString('hex');
    const result = await port.backfill(null);
    await Bun.sleep(20);
    const first = { status: result.status, detail: result.detail, events: result.events.length, cursor: result.cursor,
        health: (await port.health()).state, tokenCalls, providerCalls: fixture.requests.length, writes, unhandled,
        unchangedState: originalState === Buffer.from(fixture.state).toString('hex') };
    Date.now = originalNow;
    // Reuse this exact session with a new operation budget; do not reconnect.
    const recovered = await port.backfill(null);
    console.log(JSON.stringify({ first, recovered: { status: recovered.status, events: recovered.events.length,
        health: (await port.health()).state, tokenCalls, originalRefreshUsed,
        rotationPersisted: parseState(fixture.state).oauth.tokens.refresh_token === 'synthetic-retry-refresh' } }));
} finally { Date.now = originalNow; await port.close(); }
