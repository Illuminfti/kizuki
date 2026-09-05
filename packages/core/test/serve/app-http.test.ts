import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServeHttp } from '../../src/serve/http';
test('app session leaves daemon credentials unchanged and requires bound origin plus app bearer', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'app-http-'));
    mkdirSync(join(vault, '.kizuki'));
    writeFileSync(join(vault, '.kizuki/serve.token'), 'synthetic-standing-token');
    let calls = 0;
    const server = startServeHttp({ mode: 'app', assets: { '/': { body: '<!doctype html><title>Kizuki</title>', type: 'text/html' } }, handle: async () => { calls++; return Response.json({ ok: true, data: {} }); } });
    try {
        expect(readFileSync(join(vault, '.kizuki/serve.token'), 'utf8')).toBe('synthetic-standing-token');
        const request = (headers: Record<string, string>) => fetch(server.url + '/app/v1/status', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
        expect((await request({ origin: server.url })).status).toBe(401);
        expect((await request({ origin: 'https://foreign.invalid', authorization: `Bearer ${server.token}` })).status).toBe(403);
        expect((await request({ origin: 'null', authorization: `Bearer ${server.token}` })).status).toBe(403);
        expect((await request({ host: 'foreign.invalid', origin: server.url, authorization: `Bearer ${server.token}` })).status).toBe(403);
        expect(calls).toBe(0);
        expect((await request({ origin: server.url, authorization: `Bearer ${server.token}` })).status).toBe(200);
        expect(calls).toBe(1);
        const asset = await fetch(server.url);
        expect(asset.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
        expect(await asset.text()).not.toContain(server.token);
        expect((await fetch(server.url + '/unknown')).status).toBe(404);
    }
    finally {
        await server.stop();
        rmSync(vault, { recursive: true, force: true });
    }
});
test('app transport bounds request bodies and refuses non-JSON or cross-site API calls', async () => {
    let calls = 0;
    const server = startServeHttp({ mode: 'app', assets: {}, handle: async () => { calls++; return Response.json({ ok: true }); } });
    const headers = { origin: server.url, authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
    try {
        expect((await fetch(server.url + '/app/v1/status', { method: 'POST', headers, body: 'x'.repeat(128 * 1024 + 1) })).status).toBe(413);
        expect((await fetch(server.url + '/app/v1/status', { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(400);
        expect((await fetch(server.url + '/app/v1/status', { method: 'POST', headers: { ...headers, 'sec-fetch-site': 'cross-site' }, body: '{}' })).status).toBe(403);
        expect(calls).toBe(0);
    }
    finally {
        await server.stop();
    }
});
