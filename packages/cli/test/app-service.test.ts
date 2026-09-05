import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

test('a ledger permission failure remains an initialization failure even with a preselected default', () => {
    const env = h.isolatedEnv(), path = join(env.HOME!, 'Kizuki');
    const probe = `
        import { mock } from 'bun:test';
        import * as core from '@kizuki/core';
        const original = core.hardenLedgerFile;
        let fail = true;
        mock.module('@kizuki/core', () => ({ ...core, hardenLedgerFile(path) {
            if (fail) throw new Error('synthetic ledger permission failure');
            return original(path);
        } }));
        const { writeConfig } = await import(${JSON.stringify(resolve(import.meta.dir, '../src/config.ts'))});
        const { createAppHost } = await import(${JSON.stringify(resolve(import.meta.dir, '../src/app/host.ts'))});
        const env = ${JSON.stringify(env)};
        writeConfig(env.KIZUKI_CONFIG, {schema:'kizuki.cli.config/v1',vaults:{},default_vault:${JSON.stringify(path)}});
        const host = createAppHost({env,vaultOverride:null,out(){},err(){},prompt:async()=>''});
        const call = async (route, body={}) => (await host.handle(new Request('http://127.0.0.1/app/v1/'+route,{method:'POST',body:JSON.stringify(body)}))).json();
        const done = async () => {
            const start = await call('initialize');
            for (let i=0;i<200;i++) {
                const job = (await call('operation',{id:start.data.operation_id})).data;
                if (job.state !== 'running') return job;
                await Bun.sleep(5);
            }
            throw Error('fixture timeout');
        };
        const first = await done(), status = (await call('status')).data;
        fail = false;
        const retry = await done();
        await host.close();
        process.stdout.write(JSON.stringify({first,ready:status.vault.ready,retry:retry.state}));
    `;
    const result = Bun.spawnSync([process.execPath, '-e', probe], { cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const observed = JSON.parse(result.stdout.toString());
    expect(observed.first.error.code).toBe('unavailable');
    expect(observed.ready).toBe(false);
    expect(observed.retry).toBe('succeeded');
});

test('setup reports when the native supervisor is unavailable', async () => {
    const f = fixture();
    f.env.KIZUKI_SUPERVISOR = 'none';
    const host = f.open();
    try { expect((await call(host, 'status')).data.setup_supervisor).toBe('none'); }
    finally { await host.close(); }
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
