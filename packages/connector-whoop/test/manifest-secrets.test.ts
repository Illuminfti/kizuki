import { expect, test } from 'bun:test';
import { WhoopConnector } from '../src/connector';
import type { WhoopConfig } from '../src/connector';
const config: WhoopConfig = { secret_ref: 'file:/synthetic-state', client: { id: 'synthetic', secret: 'synthetic-client-secret' }, selection: { resources: ['cycle'], fields: ['metrics'], history_start: '2026-01-01T00:00:00Z' } };

for (const secret of ['synthetic-plaintext-credential', '', 'env:', 'env:9BAD', 'env:NAME\n', 'file:relative', 'file:/tmp/\n', 'file:/tmp/\x7f', 'file:/' + 'a'.repeat(4096), undefined, 42]) {
  test(`invalid secret reference is refused before a manifest exists (${typeof secret}, ${String(secret).length} characters)`, () => {
    let error: unknown;
    try { new WhoopConnector({ ...config, secret_ref: secret as string }, { persist: async () => {} }).manifest(); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'misconfigured' });
    if (typeof secret === 'string' && secret.length > 4) expect(String(error)).not.toContain(secret);
  });
}
for (const secret of ['env:SYNTHETIC_WHOOP_STATE', 'file:/synthetic/state']) {
  test(`valid ${secret.split(':')[0]} reference is declared without exposing client credentials`, () => {
    const manifest = new WhoopConnector({ ...config, secret_ref: secret }, { persist: async () => {} }).manifest();
    expect(manifest.required_secrets).toEqual([secret]);
    expect(JSON.stringify(manifest)).not.toContain(config.client.secret);
    expect(Object.isFrozen(manifest.required_secrets)).toBe(true);
  });
}
