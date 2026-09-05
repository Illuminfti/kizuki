import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
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
