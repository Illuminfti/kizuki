import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER, OWNER_AGENT_GRANT, addAgent, authenticate, setGrant } from '../../src/agents';
import { rebuildDerived } from '../../src/derived';
import { serveEntities } from '../../src/serving/entities';
import { serveSearch } from '../../src/serving/search';
import { canonFixture, write, type CanonFixture } from '../canon/helpers';
import { LABEL, SUBJECT, labelEvent, writeIdentity } from './subject-label-fixture';
import { DIRECT_RETRIEVAL_DESCRIPTOR, ReferenceRetrievalPort } from '../contracts/reference-retrieval';
import { temporaryPortContext } from '../contracts/fixtures';
import { nativeOwnerEvent } from '../claims/helpers';
import { undoReceipt } from '../../src/canon/undo';
import { getClaim } from '../../src/claims/store';
import type { RetrievalPort } from '../../src/contracts/retrieval';
import { projectSubjectLabels } from '../../src/serving/subject-labels';
import { loadCanon } from '../../src/serving/canon';
import { setSourceGrant, sourceCaptureAdmission, bindSourceEvent, revokeSourceGrant } from '../../src/ledger/source-grants';
import { ulid } from '../../src/util/ulid';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
function fixture() { const f = canonFixture(); cleanups.push(f.dispose); return f; }
function owner(f: CanonFixture) { return { db: f.db, vaultPath: f.vault, principal: OWNER }; }
function agent(f: CanonFixture, grant: Parameters<typeof addAgent>[2] = {}) {
  const token = addAgent(f.db, `reader-${crypto.randomUUID()}`, { ...OWNER_AGENT_GRANT, ...grant }).token;
  return { ...owner(f), principal: authenticate(f.db, token)! };
}
function rows(f: CanonFixture) { return f.db.query<{ served: string }, []>('SELECT served FROM agent_audit ORDER BY rowid DESC LIMIT 1').get(); }
function port(search: RetrievalPort['search']) {
  const fixture = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR); cleanups.push(fixture.cleanup);
  const retrieval = new ReferenceRetrievalPort(fixture.ctx); retrieval.search = search; return retrieval;
}

test('actual written identity enables exact subject labels and name/handle matching without rewriting titles or bytes', async () => {
  const f = fixture(), name = await writeIdentity(f.io);
  const handle = await writeIdentity(f.io, { predicate: 'identity.handle_on', object: '@ada-exact' });
  const bytes = readFileSync(join(f.vault, name.receipt!.page_path));
  const result = serveEntities(owner(f), { name: 'ADA EXAMPLE' });
  expect(result.canon).toHaveLength(1);
  expect(result.canon[0]!.title).toBe('a'.repeat(64));
  expect(result.canon[0]!.subject_labels).toEqual([{ subject: SUBJECT, display_name: LABEL, handles: ['@ada-exact'], evidence: expect.arrayContaining([
    { claim_id: name.claim.claim_id, authority: name.claim.authority, sources: [name.event] },
    { claim_id: handle.claim.claim_id, authority: handle.claim.authority, sources: [handle.event] },
  ]) }]);
  expect(serveEntities(owner(f), { name: '@ADA' }).canon).toHaveLength(1);
  expect(readFileSync(join(f.vault, name.receipt!.page_path))).toEqual(bytes);
  const audit = JSON.parse(rows(f)!.served);
  expect(audit.map((item: { id: string }) => item.id)).toContain(new Bun.CryptoHasher('sha256').update(name.claim.claim_id).digest('hex'));
  expect(audit.map((item: { id: string }) => item.id)).toContain(new Bun.CryptoHasher('sha256').update(handle.claim.claim_id).digest('hex'));
  expect(JSON.stringify(audit)).not.toContain(LABEL);
  rebuildDerived(f.db, f.vault);
  const search = await serveSearch(owner(f), { query: 'orchard', scope: 'all' });
  expect(search.canon[0]?.subject_labels?.[0]?.display_name).toBe(LABEL);
  expect(search.quoted.find(chunk => chunk.event_id === name.event)?.subject_labels?.[0]?.display_name).toBe(LABEL);
  expect(search.canon[0]?.sources).toEqual(expect.arrayContaining([name.event, handle.event]));
});

test('captured metadata and an unwritten identity cannot name an admitted base result', async () => {
  const f = fixture();
  await writeIdentity(f.io, { predicate: 'employment.role', object: 'gardener' });
  await writeIdentity(f.io, { written: false, object: 'UNWRITTEN_NAME' });
  const base = serveEntities(owner(f), {});
  expect(base.canon).toHaveLength(1);
  expect(base.canon[0]?.subject_labels).toBeUndefined();
  for (const name of ['UNTRUSTED_CAPTURE_NAME', 'UNTRUSTED_METADATA_NAME', 'UNWRITTEN_NAME']) expect(serveEntities(owner(f), { name }).canon).toHaveLength(0);
});

test.each([
  { valid_from: '2099-01-01T00:00:00Z' },
  { valid_to: '2021-01-01T00:00:00Z' },
  { polarity: 'negative' as const },
])('non-current or negative written claim never supplies a label: %j', async overrides => {
  const f = fixture(); await writeIdentity(f.io, overrides);
  expect(serveEntities(owner(f), {}).canon[0]?.subject_labels).toBeUndefined();
  expect(serveEntities(owner(f), { name: LABEL }).canon).toHaveLength(0);
});

test('distinct admitted live names are ambiguous, with no name-based match or arbitrary winner', async () => {
  const f = fixture();
  const first = await writeIdentity(f.io);
  const second = await writeIdentity(f.io, { object: 'Grace Other', body: 'An independent orchard account.' });
  expect(getClaim(f.db, first.claim.claim_id)?.status).toBe('live');
  expect(getClaim(f.db, second.claim.claim_id)?.status).toBe('live');
  const result = serveEntities(owner(f), {});
  expect(result.canon).toHaveLength(1);
  expect(result.canon[0]?.subject_labels).toBeUndefined();
  expect(result.data?.degraded).toContain('subject-labels-ambiguous');
  expect(serveEntities(owner(f), { name: LABEL }).canon).toHaveLength(0);
});

test('private label is admitted independently and raises public source result sensitivity without promoting source authority', async () => {
  const f = fixture(), event = labelEvent(f.db);
  await writeIdentity(f.io, { eventId: event, predicate: 'employment.role', object: 'gardener' });
  await writeIdentity(f.io, { sensitivity: 'private' });
  rebuildDerived(f.db, f.vault);
  const result = await serveSearch(owner(f), { query: 'orchard', scope: 'ledger' });
  const publicBase = result.quoted.find(chunk => chunk.event_id === event)!;
  expect(publicBase.subject_labels?.[0]?.display_name).toBe(LABEL);
  expect(publicBase.sensitivity).toBe('private');
  const denied = await serveSearch(agent(f, { ceiling: 'public' }), { query: 'orchard', scope: 'ledger' });
  expect(denied.quoted.some(chunk => chunk.event_id === event)).toBe(true);
  expect(JSON.stringify(denied)).not.toContain(LABEL);
  expect(serveEntities(agent(f, { ceiling: 'public' }), { name: LABEL }).canon).toHaveLength(0);
});

test('subject/type/time scope cannot influence matching through an unauthorized label', async () => {
  const f = fixture(); await writeIdentity(f.io);
  for (const grant of [{ subjects: ['person:someone-else'] }, { types: ['org'] }, { since: '2025-01-01T00:00:00Z' }]) {
    const result = serveEntities(agent(f, grant), { name: LABEL });
    expect(result.canon).toHaveLength(0); expect(JSON.stringify(result)).not.toContain(LABEL);
  }
});

test('unknown current page bytes and unbound receipt claims never enrich a still-servable source', async () => {
  const f = fixture(), value = await writeIdentity(f.io); rebuildDerived(f.db, f.vault);
  const path = join(f.vault, value.receipt!.page_path), original = readFileSync(path);
  writeFileSync(path, Buffer.concat([original, Buffer.from('\nUnreceipted bytes.')]));
  expect((await serveSearch(owner(f), { query: 'orchard', scope: 'ledger' })).quoted[0]?.subject_labels).toBeUndefined();
  writeFileSync(path, original);
  f.db.query('UPDATE canon_receipts SET claim_ids=? WHERE receipt_id=?').run('[]', value.receipt!.receipt_id);
  expect((await serveSearch(owner(f), { query: 'orchard', scope: 'ledger' })).quoted[0]?.subject_labels).toBeUndefined();
});

test('label source purpose withdrawal removes enrichment while independent quoted evidence remains usable', async () => {
  const f = fixture(), base = labelEvent(f.db), name = await writeIdentity(f.io);
  const source = ulid();
  f.db.query("INSERT INTO connections(connector_id,source_key,config,secret_refs,connected_at) VALUES('fixture',?,?,'[]',?)").run(source, JSON.stringify({ schema: 'kizuki.connection-config/v1', state_ref_index: null }), new Date().toISOString());
  const policy = { purposes: ['capture', 'recall', 'derive'] as ('capture' | 'recall' | 'derive')[], allowed_fields: ['text', 'subjects', 'metadata', 'attachments'] as ('text' | 'subjects' | 'metadata' | 'attachments')[], retention: 'persistent_owned_until_revoked' as const, egress: 'local_only' as const, sensitivity_floor: 'public' as const };
  setSourceGrant(f.db, { source_key: source, expected_revision: 0, operation_id: 'grant-label', policy });
  bindSourceEvent(f.db, name.event, sourceCaptureAdmission(f.db, 'fixture', source)!);
  rebuildDerived(f.db, f.vault);
  expect((await serveSearch(owner(f), { query: 'orchard', scope: 'ledger' })).quoted.find(chunk => chunk.event_id === base)?.subject_labels?.[0]?.display_name).toBe(LABEL);
  setSourceGrant(f.db, { source_key: source, expected_revision: 1, operation_id: 'withdraw-label-recall', policy: { ...policy, purposes: ['capture', 'derive'] } });
  const result = await serveSearch(owner(f), { query: 'orchard', scope: 'ledger' });
  expect(result.quoted.some(chunk => chunk.event_id === base)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(LABEL);
  setSourceGrant(f.db, { source_key: source, expected_revision: 2, operation_id: 'restore-label-recall', policy });
  expect((await serveSearch(owner(f), { query: 'orchard', scope: 'ledger' })).quoted.find(chunk => chunk.event_id === base)?.subject_labels?.[0]?.display_name).toBe(LABEL);
  revokeSourceGrant(f.db, { source_key: source, expected_revision: 3, operation_id: 'revoke-label-source' });
  const revoked = await serveSearch(owner(f), { query: 'orchard', scope: 'ledger' });
  expect(revoked.quoted.some(chunk => chunk.event_id === base)).toBe(true); expect(JSON.stringify(revoked)).not.toContain(LABEL);
});

test.each(['grant', 'claims', 'canon', 'source'] as const)('held actual retrieval cannot release stale identity after %s changes', async kind => {
  const f = fixture(), name = await writeIdentity(f.io); rebuildDerived(f.db, f.vault);
  const ctx = agent(f); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => entered = resolve), held = new Promise<void>(resolve => release = resolve);
  const retrieval = port(async () => { entered(); await held; return { hits: [{ doc_id: `event:${name.event}`, kind: 'event', score: 1, snippet: '', sensitivity: 'public', taint: 'quoted', authority: 'connector_evidence' }], degraded: [], timings_ms: {}, space: null }; });
  const pending = serveSearch({ ...ctx, retrieval }, { query: 'orchard', scope: 'all' });
  await started;
  if (kind === 'grant') setGrant(f.db, ctx.principal.kind === 'agent' ? ctx.principal.agent.name : '', { ceiling: 'public', subjects: ['person:someone-else'] });
  else if (kind === 'canon') await writeIdentity(f.io, { predicate: 'identity.handle_on', object: '@later' });
  else if (kind === 'claims') {
    const body = 'A newly admitted owner correction changes the synthetic name.';
    const event = nativeOwnerEvent(f.db, body);
    await writeIdentity(f.io, { written: false, eventId: event, object: 'Ada Pending', body, producer: 'owner', intent: 'correct' });
  } else {
    const source = ulid();
    f.db.query("INSERT INTO connections(connector_id,source_key,config,secret_refs,connected_at) VALUES('fixture',?,?,'[]',?)").run(source, JSON.stringify({ schema: 'kizuki.connection-config/v1', state_ref_index: null }), new Date().toISOString());
    setSourceGrant(f.db, { source_key: source, expected_revision: 0, operation_id: 'during-held-request', policy: { purposes: ['capture'], allowed_fields: ['text'], retention: 'persistent_owned_until_revoked', egress: 'local_only', sensitivity_floor: 'public' } });
  }
  release();
  let failure: unknown; try { await pending; } catch (error) { failure = error; }
  expect(failure).toBeDefined(); expect(String(failure)).not.toContain(LABEL);
});

test('audit failure withholds the enriched response', async () => {
  const f = fixture(); await writeIdentity(f.io);
  f.db.exec("CREATE TRIGGER reject_label_audit BEFORE UPDATE ON agent_audit BEGIN SELECT RAISE(ABORT,'synthetic audit unavailable'); END");
  expect(() => serveEntities(owner(f), { name: LABEL })).toThrow();
});

test('bounds omit whole enrichment rather than selecting an incomplete identity winner', async () => {
  const f = fixture(); await writeIdentity(f.io);
  const index = loadCanon(owner(f));
  expect(projectSubjectLabels(index, OWNER.grant, new Date().toISOString(), Array.from({ length: 51 }, (_, i) => `person:${i}`)).degraded).toEqual(['subject-labels-overflow']);
  for (let i = 0; i < 5; i++) await writeIdentity(f.io, { predicate: 'identity.handle_on', object: `@handle-${i}` });
  const result = serveEntities(owner(f), {});
  expect(result.canon[0]?.subject_labels).toBeUndefined(); expect(result.data?.degraded).toContain('subject-labels-overflow');
});

test('overlong and control-bearing values degrade without truncated identity matching', async () => {
  for (const object of ['x'.repeat(161), 'Ada\u0007Example']) {
    const f = fixture(); await writeIdentity(f.io, { object });
    const result = serveEntities(owner(f), {});
    expect(result.canon[0]?.subject_labels).toBeUndefined();
    expect(result.data?.degraded).toContain('subject-labels-unavailable');
  }
});

test('an actual owner correction becomes the admitted name and undo restores the prior written belief', async () => {
  const f = fixture(), first = await writeIdentity(f.io);
  const event = nativeOwnerEvent(f.db, 'The owner corrects the synthetic name to Ada Revised.');
  const corrected = await writeIdentity(f.io, { eventId: event, object: 'Ada Revised', body: 'The owner corrects the synthetic name to Ada Revised.', producer: 'owner', intent: 'correct', valid_from: '2021-01-01T00:00:00Z' });
  expect(corrected.claim.authority).toBe('owner_correction');
  expect(getClaim(f.db, first.claim.claim_id)?.status).toBe('superseded');
  expect(serveEntities(owner(f), { name: 'Ada Revised' }).canon[0]?.subject_labels?.[0]?.display_name).toBe('Ada Revised');
  expect(serveEntities(owner(f), { name: LABEL }).canon).toHaveLength(0);
  await undoReceipt(f.io, corrected.receipt!.receipt_id);
  expect(getClaim(f.db, corrected.claim.claim_id)?.status).toBe('reverted');
  expect(serveEntities(owner(f), { name: LABEL }).canon[0]?.subject_labels?.[0]?.display_name).toBe(LABEL);
  expect(serveEntities(owner(f), { name: 'Ada Revised' }).canon).toHaveLength(0);
});

test('the 33rd candidate prevents selection even when only the first candidate was written', async () => {
  const f = fixture(); await writeIdentity(f.io);
  for (let i = 0; i < 32; i++) await writeIdentity(f.io, { written: false, predicate: 'identity.handle_on', object: `@candidate-${i}` });
  const result = serveEntities(owner(f), {});
  expect(result.canon).toHaveLength(1); expect(result.canon[0]?.subject_labels).toBeUndefined();
  expect(result.data?.degraded).toContain('subject-labels-overflow');
});

test('the overall 257th candidate discards earlier labels instead of publishing a partial conflict scan', async () => {
  const f = fixture(); await writeIdentity(f.io);
  const subjects = [SUBJECT];
  for (let i = 0; i < 9; i++) {
    const subject = `person:overflow-${i}`; subjects.push(subject);
    for (let j = 0; j < 29; j++) await writeIdentity(f.io, { subject, written: false, predicate: 'identity.handle_on', object: `@candidate-${i}-${j}` });
  }
  const result = projectSubjectLabels(loadCanon(owner(f)), OWNER.grant, new Date().toISOString(), subjects);
  expect(result.labels.size).toBe(0); expect(result.audit.size).toBe(0); expect(result.degraded).toContain('subject-labels-overflow');
});

test('a real incomplete canonical write holds labels until its recorded recovery completes', async () => {
  const f = fixture(), first = await writeIdentity(f.io); rebuildDerived(f.db, f.vault);
  const next = await writeIdentity(f.io, { written: false, predicate: 'identity.handle_on', object: '@pending-label' });
  f.db.exec("CREATE TRIGGER label_receipt_failure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic receipt failure'); END");
  expect(() => write(f.io, next.claim)).toThrow('synthetic receipt failure');
  const held = await serveSearch(owner(f), { query: 'orchard', scope: 'ledger' });
  expect(held.quoted.some(chunk => chunk.event_id === first.event)).toBe(true);
  expect(held.quoted.every(chunk => chunk.subject_labels === undefined)).toBe(true);
  f.db.exec('DROP TRIGGER label_receipt_failure');
  const { recoverCanonWrites } = await import('../../src/canon/recovery');
  recoverCanonWrites(f.io);
  expect((await serveSearch(owner(f), { query: 'orchard', scope: 'ledger' })).quoted.find(chunk => chunk.event_id === first.event)?.subject_labels?.[0]?.handles).toContain('@pending-label');
});

test('label audit evidence never displaces reserved base items or exceeds the existing total audit cap', async () => {
  const f = fixture(); await writeIdentity(f.io);
  const index = loadCanon(owner(f)), at = new Date().toISOString();
  expect(projectSubjectLabels(index, OWNER.grant, at, [SUBJECT], 255).labels.size).toBe(1);
  const exhausted = projectSubjectLabels(index, OWNER.grant, at, [SUBJECT], 256);
  expect(exhausted.labels.size).toBe(0); expect(exhausted.audit.size).toBe(0);
  expect(exhausted.degraded).toEqual(['subject-labels-overflow']);
});

import { recordedPage } from '../helpers/recorded-page';
import { seedConnectorSensitivity } from '../../src/sensitivity/store';

test('quoted identity raises a clean canonical aggregate taint without rewriting its body or promoting authority', async () => {
  const f = fixture(), event = labelEvent(f.db, SUBJECT, 'public', 'Orchard names Ada Example.');
  await writeIdentity(f.io, { eventId: event, body: '> Orchard names Ada Example.', taint: 'quoted' });
  const base = await recordedPage(f.db, f.vault, 'facts/clean-base.md', { id: 'fact:clean-base', title: 'A clean base page', type: 'fact', status: 'active', sensitivity: 'public', taint: 'clean', subjects: [SUBJECT] }, 'Orchard base prose.');
  const bytes = readFileSync(join(f.vault, base.receipt.page_path));
  expect(bytes.toString()).toContain('taint: "clean"');
  rebuildDerived(f.db, f.vault);
  const result = await serveSearch(owner(f), { query: 'orchard', scope: 'all' });
  const chunk = result.canon.find(chunk => chunk.page_id === 'fact:clean-base')!;
  expect(chunk.subject_labels?.[0]?.display_name).toBe(LABEL); expect(chunk.taint).toBe('quoted');
  expect(chunk.authority).toBe(base.receipt.authority);
  expect(result.quoted.find(chunk => chunk.event_id === event)?.tainted).toBe(true);
  expect(readFileSync(join(f.vault, base.receipt.page_path))).toEqual(bytes);
});

test('denied rows may exhaust optional enrichment quota but only generic degradation reaches the reader', async () => {
  const f = fixture();
  // Unknown connectors default private even when a model asks for public.
  // This synthetic connector explicitly declares the intended public baseline.
  seedConnectorSensitivity(f.db, { connector_id: 'fixture', source_key: 'identity-quota' }, { default_sensitivity: 'public', sensitivity_floor: 'public' });
  const first = await writeIdentity(f.io);
  expect(first.claim.sensitivity).toBe('public');
  const ctx = agent(f, { ceiling: 'public' });
  expect(serveEntities(ctx, { name: LABEL })).toMatchObject({ canon: [expect.objectContaining({ subject_labels: expect.any(Array) })] });
  for (let i = 0; i < 33; i++) await writeIdentity(f.io, { written: false, sensitivity: 'private', predicate: 'identity.handle_on', object: `@HIDDEN_QUOTA_${i}` });
  const result = serveEntities(ctx, {});
  expect(result.canon).toHaveLength(1); expect(result.canon[0]?.subject_labels).toBeUndefined();
  expect(result.data).toEqual({ degraded: ['subject-labels-overflow'] });
  expect(result.canon[0]?.sources).toContain(first.event);
  expect(serveEntities(ctx, { name: LABEL }).canon).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain('HIDDEN_QUOTA');
  expect(result.denied).toEqual([]);
});
