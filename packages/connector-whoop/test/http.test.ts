import { test, expect } from 'bun:test';
import { Budget, HttpFailure, request } from '../src/api';

test('rate limiting falls back to WHOOP reset seconds when Retry-After is invalid', async () => {
    for (const retryAfter of ['', 'invalid', '-1']) {
        try {
            await request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic', new Budget(), async () => new Response(null, {
                status: 429, headers: { 'retry-after': retryAfter, 'x-ratelimit-reset': '120' }
            }));
            throw new Error('expected rate limit refusal');
        } catch (error) {
            expect(error).toBeInstanceOf(HttpFailure);
            expect((error as HttpFailure).retrySeconds).toBe(120);
        }
    }
});
test('rate limit headers preserve precedence and reject malformed reset delays', async () => {
    const cases: [Record<string, string>, number][] = [
        [{ 'retry-after': '30', 'x-ratelimit-reset': '120' }, 30],
        [{ 'retry-after': '0' }, 1],
        [{ 'retry-after': 'Wed, 01 Jan 2020 00:00:00 GMT', 'x-ratelimit-reset': '120' }, 1],
        [{ 'x-ratelimit-reset': '120' }, 120],
        [{ 'x-ratelimit-reset': '0' }, 1],
        [{ 'x-ratelimit-reset': '-1' }, 60],
        [{ 'x-ratelimit-reset': 'Wed, 01 Jan 2020 00:00:00 GMT' }, 60],
        [{ 'retry-after': '1.5', 'x-ratelimit-reset': '120' }, 120],
        [{ 'retry-after': 'Sun, 31 Feb 2030 00:00:00 GMT', 'x-ratelimit-reset': '120' }, 120],
        [{ 'retry-after': 'Thu, 01 Jan 2020 00:00:00 GMT', 'x-ratelimit-reset': '120' }, 120],
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
test('runtime methods outside the sanctioned read and revoke operations refuse before transport', async () => {
    const budget = new Budget();
    let calls = 0;
    for (const method of ['POST', 'PUT', 'PATCH', 'HEAD', 'get']) {
        for (const path of ['/developer/v2/cycle', '/developer/v2/user/access']) {
            await expect(request(new URL(`https://api.prod.whoop.com${path}`), 'synthetic', budget, async () => {
                calls++;
                return Response.json({});
            }, method as 'GET')).rejects.toThrow('misconfigured');
        }
    }
    expect(calls).toBe(0);
    // Refused inputs must not consume the operation's request allowance.
    for (let n = 0; n < 48; n++)
        expect(budget.requestMs()).toBeGreaterThan(0);
});

test('response-body timeout cancels a stalled stream and releases its reader', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
        cancel() { cancelled = true; }
    });
    await expect(request(new URL('https://api.prod.whoop.com/developer/v2/cycle'), 'synthetic', new Budget(), async () => new Response(body))).rejects.toThrow('timeout');
    await Bun.sleep(0);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
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
