import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLedger } from '@kizuki/core/testing';
import { inspectCanonRecovery, retryCanonProjectionObligations } from '@kizuki/core';
import { createFts5RetrievalPort, FTS5_RETRIEVAL_DESCRIPTOR } from '../../core/src/retrieval/fts5';
import { temporaryPortContext } from '../../core/test/contracts/fixtures';
import { putEvent, storeClaim, write } from '../../core/test/canon/helpers';
import { readCanonWriteIntent } from '../../core/src/canon/write-intent';
import { listCanonReceipts } from '../../core/src/canon/receipts';
import { createHelpers } from './helpers';
import { startApp } from '../src/commands/app';
import type { CliIo } from '../src/commands';

const h = createHelpers(), cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); h.cleanup(); });
async function fixture(projection = false) {
  const setup = h.tempVault(), db = openLedger(join(setup.vault, '.kizuki', 'kizuki.db'));
  cleanup.push(() => db.close());
  const event = putEvent(db), claim = await storeClaim(db, event);
  const io = { db, vault_path: setup.vault, ...(projection ? { retrieval_store: FTS5_RETRIEVAL_DESCRIPTOR.id } : {}) };
  const receipt = write(io, claim);
  return { ...setup, db, io, claim, event, receipt };
}
function failReceipt(db: ReturnType<typeof openLedger>) {
  db.exec("CREATE TRIGGER synthetic_public_receipt_failure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic-private-error-sentinel'); END");
}
function engine() {
  const temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR); cleanup.push(temporary.cleanup);
  return createFts5RetrievalPort(temporary.ctx);
}

test('actual recover and doctor processes report held completion without exposing the storage failure', async () => {
  const f = await fixture(), edit = await storeClaim(f.db, f.event, { kind: 'edit', predicate: null, object: null, body: 'Grace studies astronomy.', frontmatter: {} });
  failReceipt(f.db); expect(() => write(f.io, edit)).toThrow();
  const pending = readCanonWriteIntent(f.db)!;
  const held = h.runCli(f.env, 'recover', '--json');
  expect(held.exitCode).toBe(1);
  const result = JSON.parse(held.stdout);
  expect(result.status).toBe('error'); expect(result.data.pending).toBe(true);
  expect(result.data.receipt_id).toBe(pending.receipt.receipt_id);
  expect(held.stdout + held.stderr).not.toContain('synthetic-private-error-sentinel');
  const doctor = h.runCli(f.env, 'doctor', '--json');
  expect(JSON.parse(doctor.stdout).data.canon_recovery.receipt_id).toBe(pending.receipt.receipt_id);
  f.db.exec('DROP TRIGGER synthetic_public_receipt_failure');
  const recovered = h.runCli(f.env, 'recover', '--json');
  expect(recovered.exitCode).toBe(0);
  expect(JSON.parse(recovered.stdout).data.completed).toEqual([pending.receipt.receipt_id]);
  expect(JSON.parse(h.runCli(f.env, 'recover', '--json').stdout).data.completed).toEqual([]);
  expect(listCanonReceipts(f.db)).toHaveLength(2);
});

test('actual recover and undo processes preserve unknown external execution', async () => {
  const f = await fixture(true), port = engine(), upsert = port.upsert.bind(port);
  port.upsert = async docs => { await upsert(docs); throw Error('synthetic lost acknowledgment'); };
  try { await expect(retryCanonProjectionObligations({ ...f.io, retrieval: port })).rejects.toThrow(); }
  finally { await port.close(); }
  const recovery = h.runCli(f.env, 'recover', '--json');
  expect(recovery.exitCode).toBe(1);
  expect(JSON.parse(recovery.stdout).data).toMatchObject({ projection_pending: 1, reason: 'projection_pending', projections_completed: [] });
  const undo = h.runCli(f.env, 'undo', f.receipt.receipt_id);
  expect(undo.exitCode).toBe(1); expect(undo.stderr).toContain('recovery');
  expect(listCanonReceipts(f.db)).toHaveLength(1);
  expect(inspectCanonRecovery(f.db).projection_pending).toBe(1);
});

test('actual tell process keeps the owner statement and reports published-but-pending canon', async () => {
  const f = await fixture(); failReceipt(f.db);
  const statement = 'Grace is at Initech now.';
  const result = h.runCli(f.env, 'tell', statement, '--claim', f.claim.claim_id, '--json');
  expect(result.exitCode).toBe(1);
  const envelope = JSON.parse(result.stdout), pending = readCanonWriteIntent(f.db)!;
  expect(envelope.status).toBe('error');
  expect(envelope.data.recovery_pending).toEqual([{ receipt_id: pending.receipt.receipt_id, page_path: pending.receipt.page_path, phase: 'write' }]);
  expect(envelope.data.answer).toContain('recovery');
  expect(envelope.data.answer).not.toContain('No canon pages rewritten');
  expect(readFileSync(join(f.vault, pending.receipt.page_path), 'utf8')).toContain(statement);
  expect(f.db.query<{ text: string }, []>("SELECT text FROM events WHERE connector_id='kizuki.owner'").get()?.text).toBe(statement);
  expect(result.stdout + result.stderr).not.toContain('synthetic-private-error-sentinel');
  const retry = h.runCli(f.env, 'tell', statement, '--claim', f.claim.claim_id, '--json');
  expect(retry.exitCode).toBe(1);
  expect(JSON.parse(retry.stdout).data.recovery_pending).toEqual(envelope.data.recovery_pending);
  expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE connector_id='kizuki.owner'").get()?.n).toBe(1);
  expect(listCanonReceipts(f.db)).toHaveLength(1);
});

test('actual undo reports an uncommitted receipt after removing bytes and resumes it exactly once', async () => {
  const f = await fixture(); failReceipt(f.db);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = h.runCli(f.env, 'undo', f.receipt.receipt_id);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Undo completion is unconfirmed');
    expect(result.stdout + result.stderr).not.toContain('synthetic-private-error-sentinel');
    expect(result.stdout).not.toContain('reverts=');
    expect(existsSync(join(f.vault, f.receipt.page_path))).toBe(false);
  }
  const pending = readCanonWriteIntent(f.db)!;
  expect(pending.receipt.reverts).toBe(f.receipt.receipt_id);
  expect(listCanonReceipts(f.db)).toHaveLength(1);
  f.db.exec('DROP TRIGGER synthetic_public_receipt_failure');
  const completed = h.runCli(f.env, 'undo', f.receipt.receipt_id);
  expect(completed.exitCode).toBe(0);
  expect(completed.stdout).toContain(`receipt_id=${pending.receipt.receipt_id}`);
  expect(listCanonReceipts(f.db)).toHaveLength(2);
  expect(inspectCanonRecovery(f.db).pending).toBe(false);
});

test.each(['undo', 'undo-write', 'correct', 'correct-prior-projection', 'correct-unrelated-write'] as const)('authenticated actual app %s reports recovery pending without a success or retained page content', async kind => {
  const isUndo = kind === 'undo' || kind === 'undo-write';
  const f = await fixture(kind === 'undo' || kind === 'correct-prior-projection');
  if (kind === 'undo') {
    const port = engine();
    try { await retryCanonProjectionObligations({ ...f.io, retrieval: port }); } finally { await port.close(); }
  } else if (kind === 'correct' || kind === 'undo-write') failReceipt(f.db);
  if (kind === 'correct-unrelated-write') {
    const secondEvent = putEvent(f.db), second = await storeClaim(f.db, secondEvent, {
      target: 'people/ada', subject: 'person:ada', subjects: ['person:ada'], body: 'Ada works at Acme.',
      frontmatter: { type: 'person', title: 'Ada' },
    });
    const secondReceipt = write(f.io, second);
    const edit = await storeClaim(f.db, f.event, { kind: 'edit', predicate: null, object: null, body: 'Grace studies astronomy.', frontmatter: {} });
    failReceipt(f.db); expect(() => write(f.io, edit)).toThrow();
    f.claim = second; f.receipt = secondReceipt;
  }
  const io: CliIo = { env: f.env, vaultOverride: f.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out() {}, err() {}, prompt: async () => { throw Error('no prompt'); } };
  let token = '';
  const app = await startApp(io, { noService: true }, async raw => { token = new URL(raw).hash.slice('#token='.length); });
  const call = async (route: string, body: unknown) => {
    const response = await fetch(app.url + '/app/v1/' + route, { method: 'POST', headers: { origin: app.url, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200); return response.json() as Promise<any>;
  };
  try {
    const payload = isUndo ? { receipt_id: f.receipt.receipt_id } : { claim_id: f.claim.claim_id, statement: kind === 'correct-unrelated-write' ? 'Ada is at Initech now.' : 'Grace is at Initech now.', object: 'Initech' };
    const route = isUndo ? 'undo' : 'correct';
    const started = await call(route, payload);
    let job;
    for (let i = 0; i < 200; i++) {
      job = (await call('operation', { id: started.data.operation_id })).data;
      if (job.state !== 'running') break;
      await Bun.sleep(5);
    }
    expect(job.state).toBe('failed');
    expect(job.error).toEqual({ code: 'recovery_pending', retryable: false });
    const receiptId = kind === 'undo' ? job.result.receipt_id : kind === 'correct-prior-projection' ? f.receipt.receipt_id : readCanonWriteIntent(f.db)!.receipt.receipt_id;
    expect(job.result.recovery_pending).toEqual(kind === 'correct-unrelated-write' ? [] : [{ receipt_id: receiptId, phase: kind === 'correct' || kind === 'undo-write' ? 'write' : 'projection' }]);
    if (kind === 'correct-unrelated-write') {
      expect(JSON.stringify(job)).not.toContain(receiptId);
      expect(JSON.stringify(job)).not.toContain('people/grace.md');
    }
    expect(job.result.message).toContain('pending');
    expect(JSON.stringify(job)).not.toContain(f.receipt.page_path);
    expect(JSON.stringify(job)).not.toContain('partnerships');
    if (isUndo) {
      if (kind === 'undo') expect(inspectCanonRecovery(f.db).projection_pending).toBe(1);
      else expect(readCanonWriteIntent(f.db)!.receipt.reverts).toBe(f.receipt.receipt_id);
      expect(existsSync(join(f.vault, f.receipt.page_path))).toBe(false);
    }
    else {
      if (kind === 'correct') expect(readFileSync(join(f.vault, f.receipt.page_path), 'utf8')).toContain('Initech');
      else expect(readFileSync(join(f.vault, f.receipt.page_path), 'utf8')).not.toContain('Initech');
      expect(JSON.stringify(job)).not.toContain('Initech');
      const repeat = await call(route, payload);
      let repeated;
      for (let i = 0; i < 200; i++) {
        repeated = (await call('operation', { id: repeat.data.operation_id })).data;
        if (repeated.state !== 'running') break;
        await Bun.sleep(5);
      }
      expect(repeated.error).toEqual(job.error);
      expect(repeated.result.recovery_pending).toEqual(job.result.recovery_pending);
      expect(listCanonReceipts(f.db)).toHaveLength(kind === 'correct-unrelated-write' ? 2 : 1);
    }
  } finally { await app.close(); }
});

test('actual tell repeats an older page projection hold without duplicating owner evidence', async () => {
  const f = await fixture(true), statement = 'Grace is at Initech now.';
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = h.runCli(f.env, 'tell', statement, '--claim', f.claim.claim_id, '--json');
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.recovery_pending).toEqual([{ receipt_id: f.receipt.receipt_id, page_path: f.receipt.page_path, phase: 'projection' }]);
  }
  expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE connector_id='kizuki.owner'").get()?.n).toBe(1);
  expect(listCanonReceipts(f.db)).toHaveLength(1);
  expect(readFileSync(join(f.vault, f.receipt.page_path), 'utf8')).not.toContain('Initech');
});

test('actual tell never attributes an unrelated pending receipt or page to the authorized correction', async () => {
  const f = await fixture();
  const secondEvent = putEvent(f.db), second = await storeClaim(f.db, secondEvent, {
    target: 'people/ada', subject: 'person:ada', subjects: ['person:ada'], body: 'Ada works at Acme.',
    frontmatter: { type: 'person', title: 'Ada' },
  });
  const secondReceipt = write(f.io, second);
  const edit = await storeClaim(f.db, f.event, { kind: 'edit', predicate: null, object: null, body: 'Grace studies astronomy.', frontmatter: {} });
  failReceipt(f.db); expect(() => write(f.io, edit)).toThrow();
  const held = readCanonWriteIntent(f.db)!;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = h.runCli(f.env, 'tell', 'Ada is at Initech now.', '--claim', second.claim_id, '--json');
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.recovery_pending).toEqual([]);
    expect(result.stdout).not.toContain(held.receipt.receipt_id);
    expect(result.stdout).not.toContain(held.receipt.page_path);
    expect(result.stdout).not.toContain('Grace');
  }
  expect(readFileSync(join(f.vault, secondReceipt.page_path), 'utf8')).not.toContain('Initech');
  expect(listCanonReceipts(f.db)).toHaveLength(2);
});
