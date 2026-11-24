import { assertPositiveAuthorityMutationAllowed } from "./positive-authority";
import { isErasedReceipt } from "./receipts";
import { stampPageClasses, removePageClasses } from "./page-classes";
import { eraseReceiptRow, insertErasedReceiptRow } from "./store";
import { refreshDerivedPage, removeDerivedPage } from "../derived";
import { parseFrontmatter } from "../vault/frontmatter";
import { join } from "node:path";
import { hashBytes, ABSENT_PAGE_HASH } from "../vault/write";
import { isWorldCanonReceipt, type RetainedWorldCanonReceipt } from "./world-receipt";
import { VaultMutationError, type VaultMutationScope } from "../vault/mutation-scope";
import { requireCanonFiles, snapshotCanonIo, withCanonMutationSync } from "./io";
import { openWorldErasureReceiptStream, openOrdinaryRecoveryReceiptStream, type WorldErasureReceiptStream, type OrdinaryRecoveryReceiptStream } from "./receipt-stream";
import { commitMachineByteIntent, recordMachineBodyImages } from "../ledger/event-origin";
import { enqueueClaimRetrieval, getClaim, markClaimReverted, minTimestamp, reinstateClaim, resupersedeClaim, supersessionsForReceipt } from "../claims/store";
import { oneShotGet, tableExists } from "../ledger/schema";
import { getCanonReceipt, RECEIPTS_PATH, type CanonReceipt } from "./receipts";
import { insertReceiptRow, deletePageIndex, markReceiptReverted, upsertPageIndex, type CanonIo } from "./store";
import { canonStageRelPath } from "../vault/write";
import { publishOrdinaryCanonIntent } from "./apply";
import {
  advanceCanonReadGeneration, assertCanonAdmission, assertIndependentSurvivorAdmission, captureCanonAdmission, decodeCanonImage,
  inspectCanonRecovery, persistCanonWriteIntent, readCanonWriteIntent, recoveryFailure, CanonRecoveryError,
  type CanonCompletion, type CanonRecoveryReason, type CanonWriteIntent, type WorldCanonErasureIntent, type WorldCanonErasure,
} from "./write-intent";
import { enqueueCanonProjection, refreshCanonProjectionFloor } from "./projection-obligations";
import {
  clearCanonRecoveryHold,
  eraseCanonStageTraces,
  inspectCanonStages,
  reconcileCanonStages,
  recordCanonRecoveryHold,
  recordCanonRecoveryResolution,
  type CanonRecoveryResolutionRecord,
  type CanonStageInspection,
  type CanonStageRecoveryRecord,
} from "./stage-recovery";
import { asCanonRecoveryError } from "./recovery-failure";
import { MAX_CANON_IMAGE_BYTES } from "../ledger/canon-recovery-schema";
import { CanonWriteError } from "./errors";

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
    const prior = new Map(supersessionsForReceipt(io.db, original.receipt_id).map(row => [row.loser, row]));
    for (const ref of original.superseded) {
      const loser = getClaim(io.db, ref.claim_id);
      const supersession = prior.get(ref.claim_id);
      // The receipt retains every retirement, but only materialized source
      // revisions belong to its before image. Queued edits stay retired.
      if (supersession?.rule === "R3" && loser?.receipt_id === null &&
          loser.producer === "deterministic" &&
          typeof loser.frontmatter["x-connector"] === "string" &&
          typeof loser.frontmatter["x-source-record-id"] === "string") continue;
      reinstateClaim(io.db, ref.claim_id, supersession?.prior_valid_to ?? null);
    }
  }
  // Queue in the same completion transaction, using the durable store binding
  // even when recovery has not opened that port yet. The existing claim sweep
  // reloads current lifecycle and authority before publishing or removing it.
  const stores = new Set(original.retrieval_ops.map(op => op.store));
  for (const id of new Set([...original.claim_ids, ...original.superseded.map(ref => ref.claim_id)])) {
    const claim = getClaim(io.db, id);
    if (claim !== null) for (const store of stores) enqueueClaimRetrieval(io.db, store, claim, at);
  }
}
function completeRows(scope:VaultMutationScope,io: CanonIo, intent: CanonWriteIntent): void {
  if(intent.version===3) {completeErasureRows(scope,io,intent);return;}
  const { receipt, completion } = intent;
  // The intent and all effects are deleted/committed together. An existing row
  // with a surviving intent is not a legitimate halfway SQLite transaction.
  if (getCanonReceipt(io.db, receipt.receipt_id) !== null) recoveryFailure("receipt_changed", receipt.receipt_id);
  if (receipt.writer === "loop") recordMachineBodyImages(io.db, receipt, {
    before: decodeCanonImage(intent.before_base64)?.toString("utf8") ?? null,
    after: decodeCanonImage(intent.after_base64)?.toString("utf8") ?? null,
  });
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
  if (completion.page_id !== null) {
    const after = decodeCanonImage(intent.after_base64);
    if (after === null) removePageClasses(io.db, completion.page_id);
    else {
      const page = parseFrontmatter(after.toString("utf8"));
      stampPageClasses(io.db, { id: completion.page_id, contentHash: receipt.after_hash, ...page });
    }
  }
  enqueueCanonProjection(io.db, intent);
  io.db.query("DELETE FROM canon_write_intents WHERE singleton=1 AND receipt_id=?").run(receipt.receipt_id);
  advanceCanonReadGeneration(io.db);
}

function completeErasureRows(scope:VaultMutationScope,io:CanonIo,intent:WorldCanonErasureIntent):void {
  const receipt=intent.erasure.final_receipt;
  const machine=io.db.query<{before_hash:string|null;after_hash:string},[string]>("SELECT before_hash,after_hash FROM canon_machine_byte_intents WHERE receipt_id=?").get(receipt.receipt_id);
  if(machine===null||machine.before_hash!==intent.receipt.before_hash||machine.after_hash!==intent.receipt.after_hash)recoveryFailure("intent_invalid",receipt.receipt_id);
  io.db.query("DELETE FROM canon_machine_byte_intents WHERE receipt_id=?").run(receipt.receipt_id);
  if(isErasedReceipt(receipt))insertErasedReceiptRow(io.db,receipt);else {
    insertReceiptRow(io.db,receipt,"purge_review");
    recordMachineBodyImages(io.db,receipt,{before:null,after:decodeCanonImage(intent.after_base64)?.toString("utf8")??null});
  }
  for(const erased of intent.erasure.redactions) {
    eraseReceiptRow(io.db,erased);
    if(tableExists(io.db,"canon_write_reservations"))io.db.query("UPDATE canon_write_reservations SET page_path='',before_hash=NULL WHERE receipt_id=?").run(erased.receipt_id);
  }
  io.db.query("DELETE FROM canon_holds WHERE page_path=?").run(intent.receipt.page_path);
  // Completion and projection share the transaction. The finished intent must
  // stop holding its page before graph refresh, especially after deletion.
  io.db.query("DELETE FROM canon_write_intents WHERE singleton=1 AND receipt_id=?").run(receipt.receipt_id);
  const after=decodeCanonImage(intent.after_base64),pageId=intent.completion.page_id;
  if(after===null) {
    deletePageIndex(io.db,intent.receipt.page_path);
    if(pageId!==null)removeDerivedPage(io.db,pageId,io.vault_path,scope);
  }else {
    if(pageId===null||isErasedReceipt(receipt))recoveryFailure("intent_invalid",receipt.receipt_id);
    io.db.query("UPDATE claims SET receipt_id=? WHERE claim_id IN (SELECT value FROM json_each(?))").run(receipt.receipt_id,JSON.stringify(receipt.basis.after?.map(item=>item.claim_id)??[]));
    upsertPageIndex(io.db,{page_id:pageId,rel_path:receipt.page_path,subject_key:null,last_receipt:receipt.receipt_id,last_hash:receipt.after_hash});
    io.db.query("UPDATE page_index SET subject_key=NULL WHERE page_id=?").run(pageId);
    const page=parseFrontmatter(after.toString("utf8"));
    refreshDerivedPage(io.db,{id:pageId,path:join(io.vault_path,receipt.page_path),relPath:receipt.page_path,data:page.data,body:page.body,contentHash:receipt.after_hash},io.vault_path,scope);
  }
  advanceCanonReadGeneration(io.db);
}

function finish(scope: VaultMutationScope, io: CanonIo, intent: CanonWriteIntent, stream: OrdinaryRecoveryReceiptStream | WorldErasureReceiptStream, recovered?: CanonStageRecoveryRecord[]): CanonReceipt {
  io.db.transaction(() => {
    if (intent.receipt.kind !== "purge_rewrite") assertPositiveAuthorityMutationAllowed(io.db);
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
    completeRows(scope, io, intent);
    stream.verifyBinding();
  }).immediate();
  if(intent.version!==3)refreshCanonProjectionFloor(scope, io, intent.receipt.receipt_id);
  return intent.receipt;
}

/** One pre-admitted stream lifetime spans durable intent and exact completion. */
export function commitCanonWrite(scope: VaultMutationScope, io: CanonIo, prepared: PreparedCanonCommit, admission: () => void, charge?: () => void): CanonReceipt {
  ensureTopLevel(io); requireCanonFiles(scope, io);
  if (readCanonWriteIntent(io.db) !== null) recoveryFailure("recovery_pending");
  for (const side of ["before", "after"] as const) {
    if ((prepared[side]?.byteLength ?? 0) > MAX_CANON_IMAGE_BYTES) {
      throw new CanonWriteError("page_too_large", `canon ${side} image exceeds the recovery byte limit`);
    }
  }
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
    if (prepared.receipt.writer === "loop") commitMachineByteIntent(io.db, prepared.receipt, admit, { before: prepared.before?.toString("utf8") ?? null, after: prepared.after?.toString("utf8") ?? null });
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
    }, { before: null, after: prepared.after?.toString("utf8") ?? null });
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

export interface ResolveStaleCanonHoldOptions {
  /** Defaults to true so every mutating resolution previews safely unless explicitly applied. */
  readonly dryRun?: boolean;
}

export interface StaleCanonHoldResolution {
  readonly status: "none" | "resolvable" | "resolved" | "refused";
  readonly dry_run: boolean;
  readonly receipt_id: string | null;
  readonly page_path: string | null;
  readonly hold_reason: CanonRecoveryReason | null;
  readonly refusal_reason: string | null;
  readonly before_verified: boolean;
  readonly claim_ids: string[];
  readonly stages: CanonStageInspection[];
  readonly stage_recoveries: CanonStageRecoveryRecord[];
  readonly audit_record: CanonRecoveryResolutionRecord | null;
}

function inspectAdmissionHoldReason(io: CanonIo, intent: CanonWriteIntent): CanonRecoveryReason | "admissible" | "other_failure" {
  try {
    assertCanonAdmission(io.db, intent);
    return "admissible";
  } catch (error) {
    if (error instanceof CanonRecoveryError) return error.reason;
    return "other_failure";
  }
}

function receiptTailMatchesUnappliedIntent(
  files: ReturnType<typeof requireCanonFiles>,
  intent: CanonWriteIntent,
): boolean {
  let snapshot;
  try {
    snapshot = files.readPrivate(RECEIPTS_PATH);
  } catch {
    return false;
  }
  if (snapshot === null) {
    return intent.checkpoint.byte_length === 0;
  }
  try {
    const bytes = Buffer.from(snapshot.bytes);
    if (bytes.length < intent.checkpoint.byte_length) return false;
    const prefix = bytes.subarray(0, intent.checkpoint.byte_length);
    if (hashBytes(prefix) !== intent.checkpoint.prefix_sha256) return false;
    const tail = bytes.subarray(intent.checkpoint.byte_length);
    const expectedLine = Buffer.from(`${JSON.stringify(intent.receipt)}\n`);
    return tail.length <= expectedLine.length && tail.equals(expectedLine.subarray(0, tail.length));
  } finally {
    snapshot.close();
  }
}

/**
 * Safely aborts an unapplied ordinary canon write intent deadlocked in
 * `authority_changed` or `predecessor_changed`. Refuses whenever the live file
 * on disk has already been published (`after` bytes) or altered (`page_changed`),
 * when an archive was published, when the intent is a revert or purge, or when
 * normal recovery can still complete the write. Defaults to `dryRun: true`.
 */
export function resolveStaleCanonHoldOwned(
  scope: VaultMutationScope,
  io: CanonIo,
  options: ResolveStaleCanonHoldOptions = {},
): StaleCanonHoldResolution {
  const dryRun = options.dryRun !== false;
  ensureTopLevel(io);
  const files = requireCanonFiles(scope, io);

  let intent: CanonWriteIntent | null;
  try {
    intent = readCanonWriteIntent(io.db);
  } catch (error) {
    const typed = asCanonRecoveryError(error, inspectCanonRecovery(io.db).receipt_id);
    return {
      status: "refused",
      dry_run: dryRun,
      receipt_id: typed?.receipt_id ?? inspectCanonRecovery(io.db).receipt_id,
      page_path: inspectCanonRecovery(io.db).page_path,
      hold_reason: typed?.reason ?? "intent_invalid",
      refusal_reason: typed?.reason ?? "intent_invalid",
      before_verified: false,
      claim_ids: [],
      stages: [],
      stage_recoveries: [],
      audit_record: null,
    };
  }

  if (intent === null) {
    if (!dryRun) clearCanonRecoveryHold(files);
    return {
      status: "none",
      dry_run: dryRun,
      receipt_id: null,
      page_path: null,
      hold_reason: null,
      refusal_reason: null,
      before_verified: false,
      claim_ids: [],
      stages: [],
      stage_recoveries: [],
      audit_record: null,
    };
  }

  const receiptId = intent.receipt.receipt_id;
  const pagePath = intent.receipt.page_path;
  const claimIds = [...intent.receipt.claim_ids];
  let stages: CanonStageInspection[] = [];
  try {
    stages = inspectCanonStages(files, intent);
  } catch (error) {
    const typed = asCanonRecoveryError(error, receiptId);
    return {
      status: "refused",
      dry_run: dryRun,
      receipt_id: receiptId,
      page_path: pagePath,
      hold_reason: typed?.reason ?? "inspection_unavailable",
      refusal_reason: typed?.reason ?? "inspection_unavailable",
      before_verified: false,
      claim_ids: claimIds,
      stages: [],
      stage_recoveries: [],
      audit_record: null,
    };
  }

  const refuse = (
    refusalReason: string,
    holdReason: CanonRecoveryReason | null,
    beforeVerified = false,
  ): StaleCanonHoldResolution => ({
    status: "refused",
    dry_run: dryRun,
    receipt_id: receiptId,
    page_path: pagePath,
    hold_reason: holdReason,
    refusal_reason: refusalReason,
    before_verified: beforeVerified,
    claim_ids: claimIds,
    stages,
    stage_recoveries: [],
    audit_record: null,
  });

  if (intent.version === 3 || intent.receipt.kind !== "write" || intent.completion.mode !== "write") {
    return refuse("not_ordinary_write", null);
  }
  if (getCanonReceipt(io.db, receiptId) !== null) {
    return refuse("receipt_already_committed", "receipt_changed");
  }

  const admissionState = inspectAdmissionHoldReason(io, intent);
  if (admissionState === "admissible") {
    return refuse("not_stale_hold", null);
  }
  if (admissionState !== "authority_changed" && admissionState !== "predecessor_changed") {
    return refuse(
      admissionState === "other_failure" ? "admission_check_failed" : admissionState,
      admissionState === "other_failure" ? null : admissionState,
    );
  }
  const holdReason: CanonRecoveryReason = admissionState;

  if (stages.some(stage => stage.classification === "unsafe" || stage.action_on_next_start === "hold")) {
    return refuse("stage_custody_unknown", "stage_custody_unknown");
  }

  let actualLive: Buffer | null;
  let actualArchive: Buffer | null = null;
  try {
    actualLive = imageAt(scope, io, pagePath);
    if (intent.receipt.archive_path !== null) {
      actualArchive = imageAt(scope, io, intent.receipt.archive_path);
    }
  } catch (error) {
    const typed = asCanonRecoveryError(error, receiptId);
    return refuse(typed?.reason ?? "write_refused", holdReason);
  }

  const before = decodeCanonImage(intent.before_base64);
  const after = decodeCanonImage(intent.after_base64);
  if (!matches(actualLive, before)) {
    if (matches(actualLive, after)) {
      return refuse("already_published", holdReason, false);
    }
    return refuse("page_changed", "page_changed", false);
  }
  if (actualArchive !== null) {
    return refuse("archive_changed", "archive_changed", false);
  }

  const stream = openOrdinaryRecoveryReceiptStream(scope, io);
  try {
    try {
      stream.assertCheckpointCustody(intent.checkpoint, true);
    } catch (error) {
      const typed = asCanonRecoveryError(error, receiptId);
      return refuse(typed?.reason ?? "receipt_stream_changed", typed?.reason ?? holdReason, true);
    }
    if (!receiptTailMatchesUnappliedIntent(files, intent)) {
      return refuse("receipt_stream_refused", "receipt_stream_refused", true);
    }

    if (dryRun) {
      return {
        status: "resolvable",
        dry_run: true,
        receipt_id: receiptId,
        page_path: pagePath,
        hold_reason: holdReason,
        refusal_reason: null,
        before_verified: true,
        claim_ids: claimIds,
        stages,
        stage_recoveries: [],
        audit_record: null,
      };
    }

    const binding = io.db
      .query<{ digest: string }, [string]>(
        "SELECT digest FROM canon_write_intents WHERE singleton=1 AND receipt_id=?",
      )
      .get(receiptId);
    if (binding === null) return refuse("intent_invalid", "intent_invalid", true);

    const at = io.now?.() ?? new Date().toISOString();
    let stageRecoveries: CanonStageRecoveryRecord[] = [];
    let auditRecord: CanonRecoveryResolutionRecord | null = null;

    io.db.transaction(() => {
      const currentDigest = io.db
        .query<{ digest: string }, [string]>(
          "SELECT digest FROM canon_write_intents WHERE singleton=1 AND receipt_id=?",
        )
        .get(receiptId)?.digest;
      if (currentDigest !== binding.digest || getCanonReceipt(io.db, receiptId) !== null) {
        recoveryFailure("intent_invalid", receiptId);
      }
      const rechecked = inspectAdmissionHoldReason(io, intent);
      if (rechecked !== "authority_changed" && rechecked !== "predecessor_changed") {
        recoveryFailure("authority_changed", receiptId);
      }
      const liveNow = imageAt(scope, io, pagePath);
      if (!matches(liveNow, before)) {
        recoveryFailure("page_changed", receiptId);
      }
      if (intent.receipt.archive_path !== null && imageAt(scope, io, intent.receipt.archive_path) !== null) {
        recoveryFailure("archive_changed", receiptId);
      }
      stream.assertCheckpointCustody(intent.checkpoint, true);
      stageRecoveries = reconcileCanonStages(files, intent, { at, erase: false });
      stream.withdrawExact(intent.checkpoint, Buffer.from(`${JSON.stringify(intent.receipt)}\n`));
      stream.verifyBinding();
      auditRecord = recordCanonRecoveryResolution(files, {
        receipt_id: receiptId,
        hold_reason: rechecked,
        action: "aborted_unapplied_write",
        before_present: before !== null,
        claim_count: claimIds.length,
        stage_recoveries: stageRecoveries.length,
        at,
      });
      const removed = oneShotGet<{ receipt_id: string }>(
        io.db,
        "DELETE FROM canon_write_intents WHERE singleton=1 AND receipt_id=? AND digest=? RETURNING receipt_id",
        receiptId,
        binding.digest,
      );
      if (removed?.receipt_id !== receiptId) recoveryFailure("intent_invalid", receiptId);
      if (tableExists(io.db, "canon_machine_byte_intents")) {
        io.db.query("DELETE FROM canon_machine_byte_intents WHERE receipt_id=?").run(receiptId);
      }
      if (tableExists(io.db, "canon_machine_body_images")) {
        io.db.query("DELETE FROM canon_machine_body_images WHERE receipt_id=?").run(receiptId);
      }
      if (tableExists(io.db, "canon_write_reservations")) {
        io.db.query("DELETE FROM canon_write_reservations WHERE receipt_id=?").run(receiptId);
      }
      advanceCanonReadGeneration(io.db);
    }).immediate();

    clearCanonRecoveryHold(files);
    return {
      status: "resolved",
      dry_run: false,
      receipt_id: receiptId,
      page_path: pagePath,
      hold_reason: holdReason,
      refusal_reason: null,
      before_verified: true,
      claim_ids: claimIds,
      stages,
      stage_recoveries: stageRecoveries,
      audit_record: auditRecord,
    };
  } catch (error) {
    const typed = asCanonRecoveryError(error, receiptId);
    if (typed !== null) {
      return refuse(typed.reason, typed.reason, false);
    }
    throw error;
  } finally {
    stream.close();
  }
}

export function resolveStaleCanonHold(
  input: CanonIo,
  options: ResolveStaleCanonHoldOptions = {},
): StaleCanonHoldResolution {
  const io = snapshotCanonIo(input);
  try {
    return withCanonMutationSync(io, (scope, owned) => resolveStaleCanonHoldOwned(scope, owned, options));
  } catch (error) {
    if (error instanceof VaultMutationError && error.code === "writer_busy") {
      const summary = inspectCanonRecovery(io.db);
      return {
        status: "refused",
        dry_run: options.dryRun !== false,
        receipt_id: summary.receipt_id,
        page_path: summary.page_path,
        hold_reason: "writer_busy",
        refusal_reason: "writer_busy",
        before_verified: false,
        claim_ids: [],
        stages: [],
        stage_recoveries: [],
        audit_record: null,
      };
    }
    throw error;
  }
}
