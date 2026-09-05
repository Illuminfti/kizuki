// Isolated process: changing the clock and observing unhandled rejection events
// must not affect other connector tests. All transport and state are synthetic.
import { WhoopFixture } from '../src/testing';
const f = new WhoopFixture(1);
const originalNow = Date.now;
const start = originalNow();
let clock = start, tokenCalls = 0, unhandled = 0, writes = 0;
Date.now = () => clock;
process.on('unhandledRejection', () => { unhandled++; });
let expire = true;
const port = await f.connected({
    persist: async bytes => { writes++; await f.persist(bytes); },
    fetch: async request => {
        const response = await f.fetch(request);
        if (expire && request.url.endsWith('/user/profile/basic')) {
            // The first request completes, then both the method deadline and
            // cached access token expire before the next request starts.
            clock += 46000;
            f.time = new Date('2100-01-01T00:00:00Z');
        }
        return response;
    },
    oauth: { listen: async () => { throw Error('not enrollment'); }, postForm: async () => { tokenCalls++; throw Error('unexpected expired-budget exchange'); } },
});
try {
    const originalState = Buffer.from(f.state).toString('hex');
    const result = await port.backfill(null);
    await Bun.sleep(20);
    const first = { status: result.status, detail: result.detail, events: result.events.length, cursor: result.cursor, providerCalls: f.requests.length, tokenCalls, writes, unchangedState: originalState === Buffer.from(f.state).toString('hex'), unhandled };
    expire = false; clock = start; f.time = new Date('2026-02-01T00:00:00Z');
    await port.connect(async () => new TextDecoder().decode(f.state));
    const recovered = await port.backfill(null);
    console.log(JSON.stringify({ first, recovered: { status: recovered.status, events: recovered.events.length } }));
} finally { Date.now = originalNow; await port.close(); }
