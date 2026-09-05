import { test, expect } from 'bun:test';
import { Budget, request } from '../src/api';
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
