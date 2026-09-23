import { isErasedReceipt } from "./receipts";
import { eraseReceiptRow, insertErasedReceiptRow } from "./store";
import { refreshDerivedPage, removeDerivedPage } from "../derived";
import { parseFrontmatter } from "../vault/frontmatter";
import { join } from "node:path";
import { hashBytes, ABSENT_PAGE_HASH } from "../vault/write";
import { isWorldCanonReceipt, type RetainedWorldCanonReceipt } from "./world-receipt";
import { VaultMutationError, type VaultMutationScope } from "../vault/mutation-scope";
import { requireCanonFiles, snapshotCanonIo, withCanonMutationSync } from "./io";
import { openWorldErasureReceiptStream, openOrdinaryRecoveryReceiptStream, type WorldErasureReceiptStream, type OrdinaryRecoveryReceiptStream } from "./receipt-stream";
import { commitMachineByteIntent } from "../ledger/event-origin";
import { getClaim, markClaimReverted, minTimestamp, reinstateClaim, resupersedeClaim, supersessionsForReceipt } from "../claims/store";
import { tableExists } from "../ledger/schema";
import { getCanonReceipt, type CanonReceipt } from "./receipts";
import { insertReceiptRow, deletePageIndex, markReceiptReverted, upsertPageIndex, type CanonIo } from "./store";
import { canonStageRelPath } from "../vault/write";
import { publishOrdinaryCanonIntent } from "./apply";
import {
  advanceCanonReadGeneration, assertCanonAdmission, assertIndependentSurvivorAdmission, captureCanonAdmission, decodeCanonImage,
  inspectCanonRecovery, persistCanonWriteIntent, readCanonWriteIntent, recoveryFailure, CanonRecoveryError,
  type CanonCompletion, type CanonWriteIntent, type WorldCanonErasureIntent, type WorldCanonErasure,
} from "./write-intent";
import { enqueueCanonProjection, refreshCanonProjectionFloor } from "./projection-obligations";
import { clearCanonRecoveryHold, eraseCanonStageTraces, reconcileCanonStages, recordCanonRecoveryHold, type CanonStageRecoveryRecord } from "./stage-recovery";
import { asCanonRecoveryError } from "./recovery-failure";

export interface CanonRecoveryReport {
  completed: string[];
  pending: boolean;
  projection_pending: number;
  stage_recoveries: CanonStageRecoveryRecord[];
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
  if(intent.version===3) {
    if(matches(actual,after))return "after";
    if((actual===null?ABSENT_PAGE_HASH:hashBytes(actual))===intent.receipt.before_hash)return "before";
    recoveryFailure("page_changed",intent.receipt.receipt_id);
  }
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
  if(intent.version===3) {completeErasureRows(io,intent);return;}
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

function completeErasureRows(io:CanonIo,intent:WorldCanonErasureIntent):void {
  const receipt=intent.erasure.final_receipt;
  const machine=io.db.query<{before_hash:string|null;after_hash:string},[string]>("SELECT before_hash,after_hash FROM canon_machine_byte_intents WHERE receipt_id=?").get(receipt.receipt_id);
  if(machine===null||machine.before_hash!==intent.receipt.before_hash||machine.after_hash!==intent.receipt.after_hash)recoveryFailure("intent_invalid",receipt.receipt_id);
  io.db.query("DELETE FROM canon_machine_byte_intents WHERE receipt_id=?").run(receipt.receipt_id);
  if(isErasedReceipt(receipt))insertErasedReceiptRow(io.db,receipt);else insertReceiptRow(io.db,receipt,"purge_review");
  for(const erased of intent.erasure.redactions) {
    eraseReceiptRow(io.db,erased);
    if(tableExists(io.db,"canon_write_reservations"))io.db.query("UPDATE canon_write_reservations SET page_path='',before_hash=NULL WHERE receipt_id=?").run(erased.receipt_id);
  }
  io.db.query("DELETE FROM canon_holds WHERE page_path=?").run(intent.receipt.page_path);
  const after=decodeCanonImage(intent.after_base64),pageId=intent.completion.page_id;
  if(after===null) {
    deletePageIndex(io.db,intent.receipt.page_path);
    if(pageId!==null)removeDerivedPage(io.db,pageId,io.vault_path);
  }else {
    if(pageId===null||isErasedReceipt(receipt))recoveryFailure("intent_invalid",receipt.receipt_id);
    io.db.query("UPDATE claims SET receipt_id=? WHERE claim_id IN (SELECT value FROM json_each(?))").run(receipt.receipt_id,JSON.stringify(receipt.basis.after?.map(item=>item.claim_id)??[]));
    upsertPageIndex(io.db,{page_id:pageId,rel_path:receipt.page_path,subject_key:null,last_receipt:receipt.receipt_id,last_hash:receipt.after_hash});
    io.db.query("UPDATE page_index SET subject_key=NULL WHERE page_id=?").run(pageId);
    const page=parseFrontmatter(after.toString("utf8"));
    refreshDerivedPage(io.db,{id:pageId,path:join(io.vault_path,receipt.page_path),relPath:receipt.page_path,data:page.data,body:page.body,contentHash:receipt.after_hash},io.vault_path);
  }
  io.db.query("DELETE FROM canon_write_intents WHERE singleton=1 AND receipt_id=?").run(receipt.receipt_id);
  advanceCanonReadGeneration(io.db);
}

function finish(scope: VaultMutationScope, io: CanonIo, intent: CanonWriteIntent, stream: OrdinaryRecoveryReceiptStream | WorldErasureReceiptStream, recovered?: CanonStageRecoveryRecord[]): CanonReceipt {
  io.db.transaction(() => {
    assertCanonAdmission(io.db, intent);
    stream.verifyBinding();
    if (recovered !== undefined) {
      // A relocated stream can never complete; refuse before any file action.
      stream.assertCheckpointCustody(intent.checkpoint, intent.version !== 3);
      recovered.push(...reconcileCanonStages(requireCanonFiles(scope, io), intent, { at: io.now?.() }));
    }
    if (intent.version===3 || currentState(scope, io, intent) === "before") publishOrdinaryCanonIntent(scope, io, intent);
    if (currentState(scope, io, intent) !== "after") recoveryFailure("page_changed", intent.receipt.receipt_id);
    // Publication never calls model code; SQLite's immediate writer lock keeps
    // source policy/lifecycle writers ordered through receipt/row completion.
    assertCanonAdmission(io.db, intent);
    if(intent.version===3) {
      if(!("reconcileRedaction" in stream))recoveryFailure("intent_invalid");
      stream.reconcileRedaction({checkpoint:intent.checkpoint,after_hash:intent.erasure.log_after_hash,after_length:intent.erasure.log_after_length},intent.erasure.redactions,intent.erasure.final_receipt);
    } else {
      if(!("reconcile" in stream))recoveryFailure("intent_invalid");
      stream.reconcile(intent.checkpoint, Buffer.from(`${JSON.stringify(intent.receipt)}\n`));
    }
    stream.sync(); stream.verifyBinding();
    completeRows(io, intent);
    stream.verifyBinding();
  }).immediate();
  if(intent.version!==3)refreshCanonProjectionFloor(scope, io, intent.receipt.receipt_id);
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
        version: isWorldCanonReceipt(prepared.receipt) ? 2 : 1, receipt: prepared.receipt, before_base64: prepared.before?.toString("base64") ?? null,
        after_base64: prepared.after?.toString("base64") ?? null, completion: prepared.completion, admission: snapshot, checkpoint,
        stages: { live_stage: canonStageRelPath(prepared.receipt.page_path, prepared.receipt.receipt_id),
          archive_stage: prepared.receipt.archive_path === null ? null : canonStageRelPath(prepared.receipt.archive_path, prepared.receipt.receipt_id) },
      } as CanonWriteIntent);
      stream.verifyBinding();
    };
    if (prepared.receipt.writer === "loop") commitMachineByteIntent(io.db, prepared.receipt, admit);
    else io.db.transaction(admit).immediate();
    return finish(scope, io, intent!, stream);
  } finally { stream.close(); }
}

/** Typed purge shares the ordinary journal, native writer, receipt stream and exact recovery. */
export function commitWorldCanonErasure(scope:VaultMutationScope,io:CanonIo,prepared:{receipt:RetainedWorldCanonReceipt;after:Buffer|null;completion:CanonCompletion;erasure:Omit<WorldCanonErasure,"log_after_hash"|"log_after_length">}):CanonReceipt {
  ensureTopLevel(io);requireCanonFiles(scope,io);
  if(readCanonWriteIntent(io.db)!==null)recoveryFailure("recovery_pending");
  const stream=openWorldErasureReceiptStream(scope,io);
  try {
    const plan=stream.planRedaction(prepared.erasure.redactions,prepared.erasure.final_receipt);
    let intent:WorldCanonErasureIntent|undefined;
    commitMachineByteIntent(io.db,prepared.receipt,()=>{
      const candidate:WorldCanonErasureIntent={version:3,receipt:prepared.receipt,before_base64:null,after_base64:prepared.after?.toString("base64")??null,completion:prepared.completion,
        admission:captureCanonAdmission(io.db,prepared.receipt,prepared.completion,null,prepared.after),checkpoint:plan.checkpoint,
        stages:{live_stage:canonStageRelPath(prepared.receipt.page_path,prepared.receipt.receipt_id),archive_stage:null},
        erasure:{...prepared.erasure,log_after_hash:plan.after_hash,log_after_length:plan.after_length}};
      assertCanonAdmission(io.db,candidate);
      intent=persistCanonWriteIntent(io.db,candidate) as WorldCanonErasureIntent;stream.verifyBinding();
    });
    return finish(scope,io,intent!,stream);
  }finally{stream.close();}
}

export function recoverCanonWritesOwned(scope: VaultMutationScope, io: CanonIo): CanonRecoveryReport {
  ensureTopLevel(io); requireCanonFiles(scope, io);
  const completed: string[] = [], stageRecoveries: CanonStageRecoveryRecord[] = [];
  let intent: CanonWriteIntent | null = null, held = false;
  try {
    intent = readCanonWriteIntent(io.db);
    if (intent !== null) {
      const stream = intent.version===3?openWorldErasureReceiptStream(scope,io):openOrdinaryRecoveryReceiptStream(scope, io);
      try {
        try { finish(scope, io, intent, stream, stageRecoveries); completed.push(intent.receipt.receipt_id); }
        catch (error) {
          const after = decodeCanonImage(intent.after_base64);
          if (!(error instanceof CanonRecoveryError) || error.reason !== "authority_changed" ||
              intent.receipt.kind !== "revert" || intent.completion.mode !== "revert" || after === null) throw error;
          // Independent revert survivor: do not complete under withdrawn derive
          // ids or invent a purge-lineage rewrite. Leave the original intent.
          assertIndependentSurvivorAdmission(io.db, intent, after);
          held = true;
        }
      }
      finally { stream.close(); }
    }
  } catch (error) {
    const typed = asCanonRecoveryError(error, intent?.receipt.receipt_id ?? null);
    if (typed === null) throw error;
    recordCanonRecoveryHold(requireCanonFiles(scope, io), typed.reason, typed.receipt_id ?? inspectCanonRecovery(io.db).receipt_id, io.now?.());
    throw typed;
  }
  const summary = inspectCanonRecovery(io.db), files = requireCanonFiles(scope, io);
  // A completed erasure removes the traces of every receipt it erased. The
  // write itself is complete, and every purge and resumed purge sweeps again.
  if (intent !== null && completed.length > 0 && (intent.version === 3 || intent.completion.mode === "purge")) {
    try { eraseCanonStageTraces(files, io.db, io.vault_path); } catch { /* Doctor still reports the quarantine; a later purge pass retries. */ }
  }
  if (!summary.pending) clearCanonRecoveryHold(files);
  else if (held) recordCanonRecoveryHold(files, "authority_changed", summary.receipt_id, io.now?.());
  return { completed, pending: summary.pending, projection_pending: summary.projection_pending, stage_recoveries: stageRecoveries };
}
export function recoverCanonWrites(input: CanonIo): CanonRecoveryReport {
  const io = snapshotCanonIo(input);
  // Another writer holding the vault is a typed, transient hold, not a crash.
  try { return withCanonMutationSync(io, (scope, owned) => recoverCanonWritesOwned(scope, owned)); }
  catch (error) {
    if (error instanceof VaultMutationError && error.code === "writer_busy") throw asCanonRecoveryError(error, inspectCanonRecovery(io.db).receipt_id)!;
    throw error;
  }
}
