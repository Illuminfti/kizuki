import { expect, test, setDefaultTimeout } from 'bun:test';
import { resolve } from 'node:path';

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

for (const connected of [false, true]) test(`browser opener timeout ${connected ? 'retains' : 'refuses'} an authenticated handoff`, () => {
    // Isolate native module replacements; no real browser or child is started.
    const probe = `
        import { mock } from 'bun:test';
        import { EventEmitter } from 'node:events';
        import * as core from '@kizuki/core';
        const child = new EventEmitter();
        let killed = false, unreferenced = false;
        child.kill = () => { killed = true; child.emit('exit', null); };
        child.unref = () => { unreferenced = true; };
        mock.module('node:child_process', () => ({spawn: () => child}));
        mock.module('@kizuki/core', () => ({...core, withDeadline: (work, _ms, label) => label === 'app browser deadline' ? Promise.reject(Error('synthetic deadline')) : work}));
        const { openAppBrowser } = await import(${JSON.stringify(resolve(import.meta.dir, '../src/app/browser.ts'))});
        let failed = false;
        try { await openAppBrowser('http://127.0.0.1:12345/#token='+'A'.repeat(43), () => ${connected}); }
        catch { failed = true; }
        // A late process error must not become an unhandled event after handoff.
        child.emit('error', Error('synthetic late opener error'));
        process.stdout.write(JSON.stringify({failed,killed,unreferenced,exitListeners:child.listenerCount('exit')}));
    `;
    const result = Bun.spawnSync([process.execPath, '-e', probe], { cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({failed: !connected, killed: !connected, unreferenced: connected, exitListeners: 0});
});

test('browser opener accepts minted kzs_ app session tokens and rejects malformed URLs', () => {
    const probe = `
        import { mock } from 'bun:test';
        import { EventEmitter } from 'node:events';
        import 'node:child_process';
        const opened = [];
        mock.module('node:child_process', () => ({
            spawn: (_cmd, args) => {
                opened.push(args[0]);
                const child = new EventEmitter();
                queueMicrotask(() => child.emit('exit', 0));
                return child;
            },
        }));
        const { openAppBrowser } = await import(${JSON.stringify(resolve(import.meta.dir, '../src/app/browser.ts'))});
        const minted = 'http://127.0.0.1:43210/#token=kzs_' + 'A'.repeat(43);
        await openAppBrowser(minted);
        const rejected = [];
        for (const bad of [
            'http://127.0.0.1:43210/#token=short',
            'http://127.0.0.1:43210/?q=1#token=kzs_' + 'A'.repeat(43),
            'http://example.invalid:43210/#token=kzs_' + 'A'.repeat(43),
            'http://127.0.0.1:43210/#token=kzs_' + 'A'.repeat(44),
        ]) {
            try { await openAppBrowser(bad); rejected.push(false); }
            catch { rejected.push(true); }
        }
        process.stdout.write(JSON.stringify({ openedCount: opened.length, matchedMinted: opened[0] === minted, rejected }));
    `;
    const result = Bun.spawnSync([process.execPath, '-e', probe], { cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ openedCount: 1, matchedMinted: true, rejected: [true, true, true, true] });
});
