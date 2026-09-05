import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readServeIntent, readVaultId, type SupervisorHost } from '@kizuki/core';
import { createAppHost } from '../src/app/host';
import type { CliIo } from '../src/commands';
import { createHelpers } from './helpers';

const h = createHelpers();
afterEach(h.cleanup);
function fixture(noService = false) {
    const env = h.isolatedEnv({ KIZUKI_SUPERVISOR: 'systemd' });
    mkdirSync(env.HOME!, { recursive: true, mode: 0o700 });
    mkdirSync(env.XDG_CONFIG_HOME!, { recursive: true, mode: 0o700 });
    let active = false, installs = 0, queries = 0, fail = false;
    const supervisor: SupervisorHost = {
        kind: 'systemd', home: env.HOME!, configHome: env.XDG_CONFIG_HOME!, execStart: ['/synthetic/kizuki', 'serve'],
        query() { queries++; return { kind: 'systemd', state: active ? 'active' : 'absent', enabled: active, unit: null, detail: 'must-not-be-disclosed' }; },
        reload: () => ({ ok: true, detail: '' }),
        enable() { installs++; active = !fail; return { ok: !fail, detail: '' }; },
        disable() { active = false; return { ok: true, detail: '' }; },
    };
    const io: CliIo = { env, vaultOverride: null, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out() {}, err() {}, prompt: async () => { throw Error('unexpected prompt'); } };
    const open = () => createAppHost(io, { supervisor: () => supervisor }, { noService });
    return { env, open, get installs() { return installs; }, get queries() { return queries; }, fail(value: boolean) { fail = value; }, stop() { active = false; } };
}
async function call(host: ReturnType<typeof createAppHost>, route: string, body: unknown = {}) {
    return (await host.handle(new Request('http://127.0.0.1/app/v1/' + route, { method: 'POST', body: JSON.stringify(body) }))).json() as Promise<any>;
}
async function done(host: ReturnType<typeof createAppHost>, route: string, body: unknown = {}) {
    const start = await call(host, route, body);
    expect(start.ok).toBe(true);
    for (let i = 0; i < 200; i++) {
        const result = (await call(host, 'operation', { id: start.data.operation_id })).data;
        if (result.state !== 'running') return result;
        await Bun.sleep(5);
    }
    throw Error('synthetic operation did not finish');
}

test('default app setup installs the existing native service and reopening observes without reinstalling', async () => {
    const f = fixture(), host = f.open(), path = join(f.env.HOME!, 'Kizuki');
    try {
        expect((await done(host, 'initialize')).state).toBe('succeeded');
        expect(readServeIntent(path)).toBe('installed');
        expect(f.installs).toBe(1);
        const units = readdirSync(join(f.env.XDG_CONFIG_HOME!, 'systemd/user'));
        expect(units).toHaveLength(1);
        expect(readFileSync(join(f.env.XDG_CONFIG_HOME!, 'systemd/user', units[0]!), 'utf8')).toContain(path);
        const status = (await call(host, 'service_status')).data;
        expect(status.state).toBe('active');
        expect(status.checked_at).toBeString();
        expect(JSON.stringify(status)).not.toContain('must-not-be-disclosed');
        const before = f.queries;
        await call(host, 'status');
        await call(host, 'status');
        expect(f.queries).toBe(before); // Privacy epoch polling must not invoke a blocking OS query.
        expect((await done(host, 'initialize')).state).toBe('failed');
        expect(f.installs).toBe(1);
    } finally { await host.close(); }
    const reopened = f.open();
    try {
        expect((await call(reopened, 'service_status')).data.state).toBe('active');
        f.stop();
        expect((await call(reopened, 'service_status')).data.state).toBe('absent');
        expect(f.installs).toBe(1);
    } finally { await reopened.close(); }
});

test.each(['request', 'launcher'])('explicit %s opt-out persists and can enable the native service later', async source => {
    const f = fixture(source === 'launcher'), host = f.open(), path = join(f.env.HOME!, 'Kizuki');
    try {
        expect((await done(host, 'initialize', source === 'request' ? { no_service: true } : { no_service: false })).state).toBe('succeeded');
        expect(readServeIntent(path)).toBe('opted-out');
        expect(f.installs).toBe(0);
        expect((await call(host, 'service_status')).data.intent).toBe('opted-out');
        expect((await done(host, 'install_service')).state).toBe('succeeded');
        expect(readServeIntent(path)).toBe('installed');
        expect(f.installs).toBe(1);
    } finally { await host.close(); }
});

test('failed activation preserves the selected custom vault and retries without creating another identity', async () => {
    const f = fixture(), host = f.open(), path = join(f.env.HOME!, 'Custom');
    f.fail(true);
    try {
        const result = await done(host, 'initialize', { path });
        expect(result.state).toBe('failed');
        expect(result.error.code).toBe('service_unavailable');
        const status = (await call(host, 'status')).data;
        expect(status.vault.ready).toBe(true);
        expect(status.setup_location).toBe(path);
        expect(readServeIntent(path)).not.toBe('installed');
        const id = readVaultId(path);
        f.fail(false);
        expect((await done(host, 'install_service')).state).toBe('succeeded');
        expect(readVaultId(path)).toBe(id);
        expect((await call(host, 'service_status')).data.state).toBe('active');
    } finally { await host.close(); }
});

test('Gmail empty, unknown or malformed field selections refuse before provider setup', async () => {
    const f = fixture(), host = f.open();
    try {
        for (const fields of [[], ['not-a-field'], ['text,subjects'], [42]]) {
            const result = await call(host, 'enroll', { provider: 'gmail', fields });
            expect(result).toEqual({ ok: false, error: { code: 'invalid_request', retryable: false } });
        }
    } finally { await host.close(); }
});
