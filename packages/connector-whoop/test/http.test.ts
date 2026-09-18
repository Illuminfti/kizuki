import { test, expect } from 'bun:test';
import { Budget, request } from '../src/api';

test('invalid Retry-After falls back to WHOOP reset seconds', async () => {
    for (const retryAfter of ['', 'invalid', '-1', '1.5',
        'Fri, 31 Feb 2023 00:00:00 GMT',
        'Friday, 31-Feb-23 00:00:00 GMT',
        'Fri Feb 31 00:00:00 2023',
        'Mon, 01 Jan 2020 00:00:00 GMT',
        'Monday, 01-Jan-20 00:00:00 GMT',
        'Mon Jan  1 00:00:00 2020']) {
        await expect(request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic', new Budget(), async () => new Response(null, {
            status: 429, headers: { 'retry-after': retryAfter, 'x-ratelimit-reset': '120' }
        }))).rejects.toMatchObject({ status: 429, retrySeconds: 120 });
    }
});

test('RFC850 Retry-After resolves two-digit years relative to the current century', async () => {
    const originalNow = Date.now;
    try {
        for (const [now, header, target] of [
            [Date.UTC(2026, 8, 17), 'Saturday, 01-Jan-50 00:00:00 GMT', Date.UTC(2050, 0, 1)],
            [Date.UTC(2026, 8, 17), 'Thursday, 17-Sep-76 00:00:00 GMT', Date.UTC(2076, 8, 17)],
            [Date.UTC(2026, 8, 17), 'Friday, 17-Sep-76 00:00:01 GMT', Date.UTC(1976, 8, 17, 0, 0, 1)],
            [Date.UTC(2080, 0, 1), 'Friday, 01-Jan-00 00:00:00 GMT', Date.UTC(2100, 0, 1)]
        ] as const) {
            Date.now = () => now;
            await expect(request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic', new Budget(), async () => new Response(null, {
                status: 429, headers: { 'retry-after': header, 'x-ratelimit-reset': '120' }
            }))).rejects.toMatchObject({ status: 429, retrySeconds: Math.max(1, Math.ceil((target - now) / 1000)) });
        }
    } finally {
        Date.now = originalNow;
    }
});

test('RFC850 Retry-After parses only the selected century candidates', async () => {
    const originalNow = Date.now, originalParse = Date.parse;
    try {
        Date.now = () => Date.UTC(2026, 8, 17);
        for (const [header, candidates, seconds] of [
            ['Thursday, 17-Sep-26 00:02:00 GMT', ['Thursday, 17-Sep-2026 00:02:00 GMT'], 120],
            ['Friday, 17-Sep-76 00:00:01 GMT', ['Friday, 17-Sep-2076 00:00:01 GMT', 'Friday, 17-Sep-1976 00:00:01 GMT'], 1]
        ] as const) {
            const parsed: string[] = [];
            Date.parse = (raw) => {
                parsed.push(raw);
                return originalParse(raw);
            };
            await expect(request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic', new Budget(), async () => new Response(null, {
                status: 429, headers: { 'retry-after': header, 'x-ratelimit-reset': '300' }
            }))).rejects.toMatchObject({ status: 429, retrySeconds: seconds });
            expect(parsed).toEqual([...candidates]);
        }
    } finally {
        Date.now = originalNow;
        Date.parse = originalParse;
    }
});

test('RFC850 Retry-After uses one clock sample for year resolution and delay', async () => {
    const originalNow = Date.now;
    const now = Date.UTC(2026, 8, 17);
    try {
        for (const jump of [-60000, 60000]) {
            Date.now = () => now;
            let samples = 0;
            await expect(request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic', new Budget(), async () => {
                Date.now = () => now + (samples++ === 0 ? 0 : jump);
                return new Response(null, {
                    status: 429, headers: { 'retry-after': 'Thursday, 17-Sep-26 00:02:00 GMT' }
                });
            })).rejects.toMatchObject({ status: 429, retrySeconds: 120 });
            expect(samples).toBe(1);
        }
    } finally {
        Date.now = originalNow;
    }
});

test('overlong Retry-After dates fall back before date parsing', async () => {
    const originalParse = Date.parse;
    let parses = 0;
    try {
        Date.parse = (raw) => {
            parses++;
            return originalParse(raw);
        };
        await expect(request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic', new Budget(), async () => new Response(null, {
            status: 429, headers: { 'retry-after': `${'W'.repeat(40)}, 16-Sep-26 00:00:00 GMT`, 'x-ratelimit-reset': '120' }
        }))).rejects.toMatchObject({ status: 429, retrySeconds: 120 });
        expect(parses).toBe(0);
    } finally {
        Date.parse = originalParse;
    }
    // Wednesday makes the longest valid HTTP-date form exactly 33 characters.
    await expect(request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic', new Budget(), async () => new Response(null, {
        status: 429, headers: { 'retry-after': 'Wednesday, 01-Jan-20 00:00:00 GMT', 'x-ratelimit-reset': '120' }
    }))).rejects.toMatchObject({ status: 429, retrySeconds: 1 });
});

test('asctime Retry-After accepts both single-digit day representations', async () => {
    const originalNow = Date.now;
    try {
        Date.now = () => Date.UTC(2026, 0, 1);
        for (const day of [' 1', '01']) {
            await expect(request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic', new Budget(), async () => new Response(null, {
                status: 429, headers: { 'retry-after': `Thu Jan ${day} 00:02:00 2026`, 'x-ratelimit-reset': '300' }
            }))).rejects.toMatchObject({ status: 429, retrySeconds: 120 });
        }
        for (const header of ['Fri Jan 01 00:02:00 2026', 'Thu Feb 31 00:02:00 2026']) {
            await expect(request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic', new Budget(), async () => new Response(null, {
                status: 429, headers: { 'retry-after': header, 'x-ratelimit-reset': '300' }
            }))).rejects.toMatchObject({ status: 429, retrySeconds: 300 });
        }
    } finally {
        Date.now = originalNow;
    }
});

test('rate limit headers preserve precedence and reject malformed reset delays', async () => {
    const cases: [Record<string, string>, number][] = [
        [{ 'retry-after': '30', 'x-ratelimit-reset': '120' }, 30],
        [{ 'retry-after': '0' }, 1],
        [{ 'retry-after': 'Wed, 01 Jan 2020 00:00:00 GMT', 'x-ratelimit-reset': '120' }, 1],
        [{ 'retry-after': 'Sunday, 06-Nov-94 08:49:37 GMT', 'x-ratelimit-reset': '120' }, 1],
        [{ 'retry-after': 'Sun Nov  6 08:49:37 1994', 'x-ratelimit-reset': '120' }, 1],
        [{ 'x-ratelimit-reset': '120' }, 120],
        [{ 'x-ratelimit-reset': '0' }, 1],
        [{ 'x-ratelimit-reset': '-1' }, 60],
        [{ 'x-ratelimit-reset': 'Wed, 01 Jan 2020 00:00:00 GMT' }, 60],
        [{}, 60]
    ];
    for (const [headers, seconds] of cases) {
        await expect(request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic', new Budget(), async () => new Response(null, {
            status: 429, headers
        }))).rejects.toMatchObject({ status: 429, retrySeconds: seconds });
    }
});
test('request refuses foreign routes before transport and never follows bearer redirects', async () => {
    let calls = 0;
    for (const raw of ['https://outside.example/developer/v2/cycle', 'https://api.prod.whoop.com/developer/v2/partner/token', 'https://api.prod.whoop.com@outside.example/developer/v2/cycle'])
        await expect(request(new URL(raw), 'synthetic-token', new Budget(), async () => {
            calls++;
            return Response.json({});
        })).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic-token', new Budget(), async (r) => {
        expect(r.redirect).toBe('error');
        expect(r.headers.get('authorization')).toBe('Bearer synthetic-token');
        return new Response('PRIVATE_PROVIDER_BODY', {
            status: 302, headers: {
                location: 'https://outside.example'
            }
        });
    })).rejects.toThrow('WHOOP request refused');
});
test('declared and streamed oversized bodies refuse and hanging HTTP is bounded/redacted', async () => {
    const url = new URL('https://api.prod.whoop.com/developer/v2/cycle');
    await expect(request(url, 'synthetic', new Budget(), async () => new Response('{}', {
        headers: {
            'content-length': '99999999'
        }
    }))).rejects.toThrow('response_limit');
    await expect(request(url, 'synthetic', new Budget(), async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)))).rejects.toThrow('response_limit');
    const start = Date.now();
    await expect(request(url, 'synthetic', new Budget(), async () => new Promise(() => {
    }))).rejects.toThrow('timeout');
    expect(Date.now() - start).toBeLessThan(6500);
}, 8000);
test('operation request budget refuses its forty-ninth call', () => {
    const budget = new Budget();
    for (let n = 0; n < 48; n++)
        expect(budget.requestMs()).toBeGreaterThan(0);
    expect(() => budget.requestMs()).toThrow('request_limit');
});

test('exhausted operation refuses before constructing bearer transport', async () => {
    const budget = new Budget();
    for (let n = 0; n < 48; n++) budget.requestMs();
    let calls = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
        await expect(request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic', budget, async () => {
            calls++;
            return Response.json({});
        })).rejects.toThrow('request_limit');
    }
    expect(calls).toBe(0);
});
