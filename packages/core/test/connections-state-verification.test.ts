import { afterEach, expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLedger } from '../src/ledger/db';
import { createStatePersister } from '../src/ledger/state-persister';
import { listConnections } from '../src/ledger/connections';
import { setSourceGrant, inspectSourceGrant, revokeSourceGrant } from '../src/ledger/source-grants';
import { connector, enrolled, io, temporaryDirectories } from './connections-helpers';
const dirs = temporaryDirectories('state-verifier-'); afterEach(dirs.cleanup);
const bytes = (text: string) => new TextEncoder().encode(text);
const replacement = () => connector(async (_io, writer) => { await writer.write(bytes('new-credentials')); return { display: 'synthetic' }; });
const policy = { purposes: ['capture'] as const, allowed_fields: ['metadata'] as const, retention: 'persistent_owned_until_revoked' as const, egress: 'local_only' as const, sensitivity_floor: 'private' as const };
function grant(db: ReturnType<typeof openLedger>, source: string) { setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: 'synthetic-state-grant', policy: { ...policy, purposes: [...policy.purposes], allowed_fields: [...policy.allowed_fields] } }); }

test('replacement policy runs under the publication lock and excludes a second native grant writer', async () => {
  const directory = dirs.temporary(), { db, store, connection } = await enrolled(directory, 'old-credentials'), other = openLedger(join(directory, 'ledger.sqlite'));
  try {
    grant(db, connection.source_key); let checked = 0;
    await store.replace(db, connection, replacement(), io, () => {
      checked++; expect(db.inTransaction).toBe(true);
      expect(() => revokeSourceGrant(other, { source_key: connection.source_key, expected_revision: 1, operation_id: 'synthetic-concurrent-revoke' })).toThrow();
      expect(inspectSourceGrant(db, connection.source_key)?.revision).toBe(1);
    });
    expect(checked).toBe(1); expect(new TextDecoder().decode(store.read(listConnections(db)[0]!)!)).toBe('new-credentials');
  } finally { other.close(); db.close(); }
});

test('grant changed at the former verifier-to-save seam is rechecked under lock and refuses publication', async () => {
  const directory = dirs.temporary(), { db, store, connection } = await enrolled(directory, 'old-credentials'), other = openLedger(join(directory, 'ledger.sqlite'));
  try {
    grant(db, connection.source_key); const save = store.save.bind(store); let changed = false;
    store.save = (...args) => {
      if (!changed) { changed = true; revokeSourceGrant(other, { source_key: connection.source_key, expected_revision: 1, operation_id: 'synthetic-seam-revoke' }); }
      return save(...args);
    };
    await expect(store.replace(db, connection, replacement(), io, () => {
      if (inspectSourceGrant(db, connection.source_key)?.revision !== 1) throw Error('source revision changed');
    })).rejects.toThrow('source revision changed');
    expect(store.read(connection)).toEqual(bytes('old-credentials')); expect(inspectSourceGrant(db, connection.source_key)?.status).toBe('denied');
    expect(readdirSync(store.directory)).toEqual([`${connection.source_key}.state`]);
  } finally { other.close(); db.close(); }
});

for (const mode of ['original', 'staged', 'async'] as const) test(`replacement verifier refuses ${mode} custody changes`, async () => {
  const { db, store, connection } = await enrolled(dirs.temporary(), 'old-credentials');
  try {
    const original = join(store.directory, `${connection.source_key}.state`);
    const port = connector(async (_io, writer) => {
      await writer.write(bytes('new-credentials'));
      if (mode === 'original') writeFileSync(original, 'tampered-original');
      return { display: 'synthetic' };
    });
    await expect(store.replace(db, connection, port, io, () => {
      if (mode === 'staged') { const staged = readdirSync(store.directory).find(name => name.endsWith('.tmp'))!; writeFileSync(join(store.directory, staged), 'tampered-candidate'); }
      if (mode === 'async') return Promise.resolve();
    })).rejects.toThrow(mode === 'original' ? 'original state changed' : mode === 'staged' ? 'staged digest mismatch' : 'synchronously');
    expect(readFileSync(original, 'utf8')).toBe(mode === 'original' ? 'tampered-original' : 'old-credentials');
    expect(readdirSync(store.directory)).toEqual([`${connection.source_key}.state`]);
  } finally { db.close(); }
});

test('nested state rewrite refuses before recovery, writer or any state-file mutation', async () => {
  const { db, store, connection } = await enrolled(dirs.temporary(), 'old-credentials');
  let writes = 0;
  try {
    const before = readdirSync(store.directory).map(name => [name, readFileSync(join(store.directory, name)).toString('hex')]);
    db.exec('BEGIN IMMEDIATE');
    await expect(store.rewrite(db, connection, async writer => { writes++; await writer.write(bytes('nested')); })).rejects.toThrow('top-level transaction');
    await expect(createStatePersister(db, store, connection).persist(bytes('nested-marker'))).rejects.toThrow('top-level transaction');
    expect(writes).toBe(0); expect(readdirSync(store.directory).map(name => [name, readFileSync(join(store.directory, name)).toString('hex')])).toEqual(before);
    db.exec('ROLLBACK'); expect(store.read(connection)).toEqual(bytes('old-credentials'));
  } finally { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); }
});
