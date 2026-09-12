import type { VaultMutationScope } from "../vault/mutation-scope";
import { requireCanonFiles, snapshotCanonIo, withCanonMutationSync } from "./io";
import { openOrdinaryRecoveryReceiptStream } from "./receipt-stream";
import { commitMachineByteIntent } from "../ledger/event-origin";
import { getClaim, markClaimReverted, minTimestamp, reinstateClaim, resupersedeClaim, supersessionsForReceipt } from "../claims/store";
import { tableExists } from "../ledger/schema";
import { getCanonReceipt, type CanonReceipt } from "./receipts";
import { insertReceiptRow, deletePageIndex, markReceiptReverted, upsertPageIndex, type CanonIo } from "./store";
import { canonStageRelPath } from "../vault/write";
import { publishOrdinaryCanonIntent } from "./apply";
import {
  advanceCanonReadGeneration, assertCanonAdmission, captureCanonAdmission, decodeCanonImage,
  inspectCanonRecovery, persistCanonWriteIntent, readCanonWriteIntent, recoveryFailure,
  type CanonCompletion, type CanonWriteIntent,
} from "./write-intent";
import { enqueueCanonProjection, refreshCanonProjectionFloor } from "./projection-obligations";

export interface CanonRecoveryReport {
  completed: string[];
  pending: boolean;
  projection_pending: number;
}
export interface PreparedCanonCommit {
  receipt: CanonReceipt;
  before: Buffer | null;
  after: Buffer | null;
  completion: CanonCompletion;
}

function ensureTopLevel(io: CanonIo): void {
  if (io.db.inTransaction) recoveryFailure("nested_transaction");
}
function imageAt(scope: VaultMutationScope, io: CanonIo, path: string): Buffer | null {
  const snapshot = requireCanonFiles(scope, io).read(path);
  if (snapshot === null) return null;
  try { return Buffer.from(snapshot.bytes); } finally { snapshot.close(); }
}
function matches(actual: Buffer | null, expected: Buffer | null): boolean {
  return actual === null ? expected === null : expected !== null && actual.equals(expected);
}
function currentState(scope: VaultMutationScope, io: CanonIo, intent: CanonWriteIntent): "before" | "after" {
  const actual = imageAt(scope, io, intent.receipt.page_path);
  const before = decodeCanonImage(intent.before_base64), after = decodeCanonImage(intent.after_base64);
  if (matches(actual, after)) {
    if (intent.receipt.archive_path !== null && !matches(imageAt(scope, io, intent.receipt.archive_path), before)) {
      if (matches(actual, before) && imageAt(scope, io, intent.receipt.archive_path) === null) return "before";
      recoveryFailure("archive_changed", intent.receipt.receipt_id);
    }
    // Equal images still need their archive publication before completion.
    return "after";
  }
  if (matches(actual, before)) return "before";
  recoveryFailure("page_changed", intent.receipt.receipt_id);
}

function restoreClaimLifecycle(io: CanonIo, original: CanonReceipt, at: string): void {
  if (original.kind === "revert") {
    for (const id of original.claim_ids) {
      const claim = getClaim(io.db, id);
      if (claim !== null) reinstateClaim(io.db, id, claim.valid_to);
    }
    const winnerId = original.claim_ids[0];
    const rows = original.reverts === null ? [] : supersessionsForReceipt(io.db, original.reverts);
    const prior = new Map(rows.map(row => [row.loser, row.prior_valid_to]));
    const winner = winnerId === undefined ? null : getClaim(io.db, winnerId);
    for (const ref of original.superseded) if (winnerId !== undefined) {
      resupersedeClaim(io.db, ref.claim_id, winnerId, at, minTimestamp(prior.get(ref.claim_id) ?? null, winner?.valid_from ?? null));
    }
  } else {
    for (const id of original.claim_ids) markClaimReverted(io.db, id, at);
    const prior = new Map(supersessionsForReceipt(io.db, original.receipt_id).map(row => [row.loser, row.prior_valid_to]));
    for (const ref of original.superseded) reinstateClaim(io.db, ref.claim_id, prior.get(ref.claim_id) ?? null);
  }
}
function completeRows(io: CanonIo, intent: CanonWriteIntent): void {
  const { receipt, completion } = intent;
  // The intent and all effects are deleted/committed together. An existing row
  // with a surviving intent is not a legitimate halfway SQLite transaction.
  if (getCanonReceipt(io.db, receipt.receipt_id) !== null) recoveryFailure("receipt_changed", receipt.receipt_id);
  insertReceiptRow(io.db, receipt, completion.claim_kind);
  if (completion.mode === "write") {
    const ids = JSON.stringify(receipt.claim_ids);
    io.db.query("UPDATE claims SET receipt_id=? WHERE claim_id IN (SELECT value FROM json_each(?))").run(receipt.receipt_id, ids);
    io.db.query("UPDATE claim_supersessions SET receipt_id=? WHERE winner IN (SELECT value FROM json_each(?))").run(receipt.receipt_id, ids);
    for (const id of receipt.claim_ids) {
      const claim = getClaim(io.db, id);
      if (claim?.claim_key !== null && claim?.claim_key !== undefined && completion.page_id !== null) {
        io.db.query("INSERT OR IGNORE INTO claim_bindings (claim_key,page_id,bound_at) VALUES (?,?,?)").run(claim.claim_key, completion.page_id, receipt.at);
      }
    }
    if (tableExists(io.db, "proposals")) io.db.query("UPDATE proposals SET status='promoted' WHERE proposal_id IN (SELECT value FROM json_each(?))").run(ids);
  } else if (completion.mode === "revert") {
    const original = completion.original_receipt_id === null ? null : getCanonReceipt(io.db, completion.original_receipt_id);
    if (original === null || original.reverted_by !== null) recoveryFailure("predecessor_changed", receipt.receipt_id);
    restoreClaimLifecycle(io, original, receipt.at);
    markReceiptReverted(io.db, original.receipt_id, receipt.receipt_id);
  } else {
    io.db.query("DELETE FROM canon_holds WHERE page_path=?").run(receipt.page_path);
  }
  if (intent.after_base64 === null) deletePageIndex(io.db, receipt.page_path);
  else if (completion.page_id !== null) upsertPageIndex(io.db, {
    page_id: completion.page_id, rel_path: receipt.page_path, subject_key: completion.subject_key,
    last_receipt: receipt.receipt_id, last_hash: receipt.after_hash,
  });
  enqueueCanonProjection(io.db, intent);
  io.db.query("DELETE FROM canon_write_intents WHERE singleton=1 AND receipt_id=?").run(receipt.receipt_id);
  advanceCanonReadGeneration(io.db);
}

function finish(scope: VaultMutationScope, io: CanonIo, intent: CanonWriteIntent, stream: ReturnType<typeof openOrdinaryRecoveryReceiptStream>): CanonReceipt {
  io.db.transaction(() => {
    assertCanonAdmission(io.db, intent);
    stream.verifyBinding();
    if (currentState(scope, io, intent) === "before") publishOrdinaryCanonIntent(scope, io, intent);
    if (currentState(scope, io, intent) !== "after") recoveryFailure("page_changed", intent.receipt.receipt_id);
    // Publication never calls model code; SQLite's immediate writer lock keeps
    // source policy/lifecycle writers ordered through receipt/row completion.
    assertCanonAdmission(io.db, intent);
    stream.reconcile(intent.checkpoint, Buffer.from(`${JSON.stringify(intent.receipt)}\n`));
    stream.sync(); stream.verifyBinding();
    completeRows(io, intent);
    stream.verifyBinding();
  }).immediate();
  refreshCanonProjectionFloor(scope, io, intent.receipt.receipt_id);
  return intent.receipt;
}

/** One pre-admitted stream lifetime spans durable intent and exact completion. */
export function commitCanonWrite(scope: VaultMutationScope, io: CanonIo, prepared: PreparedCanonCommit, admission: () => void, charge?: () => void): CanonReceipt {
  ensureTopLevel(io); requireCanonFiles(scope, io);
  if (readCanonWriteIntent(io.db) !== null) recoveryFailure("recovery_pending");
  const stream = openOrdinaryRecoveryReceiptStream(scope, io);
  try {
    const checkpoint = stream.checkpoint();
    let intent: CanonWriteIntent | undefined;
    const admit = (): void => {
      admission(); charge?.(); admission();
      const snapshot = captureCanonAdmission(io.db, prepared.receipt, prepared.completion, prepared.before, prepared.after);
      intent = persistCanonWriteIntent(io.db, {
        version: 1, receipt: prepared.receipt, before_base64: prepared.before?.toString("base64") ?? null,
        after_base64: prepared.after?.toString("base64") ?? null, completion: prepared.completion, admission: snapshot, checkpoint,
        stages: { live_stage: canonStageRelPath(prepared.receipt.page_path, prepared.receipt.receipt_id),
          archive_stage: prepared.receipt.archive_path === null ? null : canonStageRelPath(prepared.receipt.archive_path, prepared.receipt.receipt_id) },
      });
      stream.verifyBinding();
    };
    if (prepared.receipt.writer === "loop") commitMachineByteIntent(io.db, prepared.receipt, admit);
    else io.db.transaction(admit).immediate();
    return finish(scope, io, intent!, stream);
  } finally { stream.close(); }
}

export function recoverCanonWritesOwned(scope: VaultMutationScope, io: CanonIo): CanonRecoveryReport {
  ensureTopLevel(io); requireCanonFiles(scope, io);
  const intent = readCanonWriteIntent(io.db);
  const completed: string[] = [];
  if (intent !== null) {
    const stream = openOrdinaryRecoveryReceiptStream(scope, io);
    try { finish(scope, io, intent, stream); completed.push(intent.receipt.receipt_id); }
    finally { stream.close(); }
  }
  const summary = inspectCanonRecovery(io.db);
  return { completed, pending: summary.pending, projection_pending: summary.projection_pending };
}
export function recoverCanonWrites(input: CanonIo): CanonRecoveryReport {
  const io = snapshotCanonIo(input);
  return withCanonMutationSync(io, (scope, owned) => recoverCanonWritesOwned(scope, owned));
}
