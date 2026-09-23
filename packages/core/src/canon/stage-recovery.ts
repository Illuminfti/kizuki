import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { CanonFilesError, openCanonFiles, type CanonFiles, type CanonFileSnapshot } from "../vault/canon-files";
import { hashBytes } from "../vault/write";
import { isPlainObject } from "../util/validate";
import { isUlid, ulid } from "../util/ulid";
import { tableExists } from "../ledger/schema";
import { eventIdFromReference } from "../retrieval/ids";
import { CanonRecoveryError, decodeCanonImage, inspectCanonRecovery, readCanonWriteIntent, recoveryFailure, type CanonRecoveryReason, type CanonRecoverySummary, type CanonWriteIntent } from "./write-intent";

/** Bounded record of each stage recovery action. It names the stage role,
 * classification and outcome, never a page path, stage name or content hash. */
export const CANON_STAGE_RECOVERIES_PATH = ".kizuki/receipts/stage-recoveries.jsonl";
/** Foreign stage bytes of an ordinary write are moved here, never deleted. */
export const CANON_STAGE_QUARANTINE_PATH = ".kizuki/quarantine/canon-stage";
/** Last held recovery attempt, for doctor. Rewritten atomically; not a receipt. */
export const CANON_RECOVERY_HOLD_PATH = ".kizuki/canon-recovery-hold.json";
const RECORD_SCHEMA = "kizuki.canon-stage-recovery/v2";
const HOLD_SCHEMA = "kizuki.canon-recovery-hold/v1";
/** The log is diagnostics, not a receipt: the oldest records fall off past this bound. */
const RECORD_LIMIT = 512;
const QUARANTINE_SCAN_LIMIT = 4096;

export type CanonStageKind = "live" | "archive";
/** exact: byte-identical to an intent image. prefix: a torn write of one.
 * foreign: other bytes. unsafe: not a private regular file this user owns. */
export type CanonStageClassification = "exact" | "prefix" | "foreign" | "unsafe";
export interface CanonStageInspection {
  readonly stage: CanonStageKind;
  readonly path: string;
  readonly present: boolean;
  readonly classification: CanonStageClassification | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly expected_sha256: string | null;
  readonly action_on_next_start: "none" | "remove" | "quarantine" | "hold";
}
export interface CanonStageRecoveryRecord {
  readonly schema: typeof RECORD_SCHEMA;
  /** Random per action; it identifies the record and derives from no content. */
  readonly id: string;
  readonly receipt_id: string;
  readonly stage: CanonStageKind;
  readonly classification: "exact" | "prefix" | "foreign";
  readonly action: "removed" | "quarantined";
  /** planned is written before the action and becomes done after it succeeds. */
  readonly outcome: "planned" | "done";
  readonly quarantine_path: string | null;
  readonly at: string;
}
export interface CanonRecoveryHold {
  readonly schema: typeof HOLD_SCHEMA;
  readonly receipt_id: string | null;
  readonly reason: CanonRecoveryReason;
  readonly at: string;
  readonly attempts: number;
}
export interface CanonQuarantineInspection {
  readonly state: "absent" | "private" | "unsafe";
  readonly files: number;
}

interface Observed {
  readonly stage: CanonStageKind;
  readonly path: string;
  readonly snapshot: CanonFileSnapshot | null;
  readonly unsafe: boolean;
  readonly bytes: Buffer | null;
  readonly classification: CanonStageClassification | null;
  readonly expected: Buffer | null;
}

function stagePaths(intent: CanonWriteIntent): [CanonStageKind, string][] {
  return [["live", intent.stages.live_stage], ...(intent.stages.archive_stage === null ? [] : [["archive", intent.stages.archive_stage] as [CanonStageKind, string]])];
}
/** The live stage carries the postimage, or the preimage while a source
 * withdrawal rolls a page back. The archive stage carries the preimage. */
function expectedImages(intent: CanonWriteIntent, stage: CanonStageKind): Buffer[] {
  const before = decodeCanonImage(intent.before_base64), after = decodeCanonImage(intent.after_base64);
  return (stage === "live" ? [after, before] : [before]).filter((image): image is Buffer => image !== null);
}
/** A purge or erasure exists to remove bytes, so its foreign stage bytes are removed too. */
function erasesStages(intent: CanonWriteIntent): boolean {
  return intent.version === 3 || intent.completion.mode === "purge";
}
function classify(bytes: Buffer, images: readonly Buffer[]): { classification: "exact" | "prefix" | "foreign"; expected: Buffer | null } {
  const exact = images.find(image => image.equals(bytes));
  if (exact !== undefined) return { classification: "exact", expected: exact };
  const prefix = images.find(image => bytes.length < image.length && image.subarray(0, bytes.length).equals(bytes));
  if (prefix !== undefined) return { classification: "prefix", expected: prefix };
  return { classification: "foreign", expected: images[0] ?? null };
}
function observe(files: CanonFiles, intent: CanonWriteIntent): Observed[] {
  const observed: Observed[] = [];
  try {
    for (const [stage, path] of stagePaths(intent)) {
      let snapshot: CanonFileSnapshot | null;
      try { snapshot = files.read(path); }
      catch (error) {
        // A symlink, directory, hardlink, foreign owner, writable mode or
        // oversize entry is left exactly where it is.
        if (!(error instanceof CanonFilesError) || !["unsafe", "bounds", "changed"].includes(error.reason)) throw error;
        observed.push({ stage, path, snapshot: null, unsafe: true, bytes: null, classification: "unsafe", expected: null });
        continue;
      }
      if (snapshot === null) { observed.push({ stage, path, snapshot, unsafe: false, bytes: null, classification: null, expected: null }); continue; }
      const bytes = Buffer.from(snapshot.bytes), result = classify(bytes, expectedImages(intent, stage));
      observed.push({ stage, path, snapshot, unsafe: false, bytes, ...result });
    }
    return observed;
  } catch (error) { for (const item of observed) item.snapshot?.close(); throw error; }
}

/** Read-only classification for doctor; it never removes or moves an entry. */
export function inspectCanonStages(files: CanonFiles, intent: CanonWriteIntent): CanonStageInspection[] {
  const observed = observe(files, intent), erase = erasesStages(intent);
  try {
    return observed.map(item => ({
      stage: item.stage, path: item.path, present: item.snapshot !== null || item.unsafe,
      classification: item.classification, bytes: item.bytes?.length ?? null,
      sha256: item.bytes === null ? null : hashBytes(item.bytes),
      expected_sha256: item.expected === null ? null : hashBytes(item.expected),
      action_on_next_start: item.unsafe ? "hold" : item.classification === null ? "none" :
        item.classification === "foreign" && !erase ? "quarantine" : "remove",
    }));
  } finally { for (const item of observed) item.snapshot?.close(); }
}

/** Whole-file replacement through the scope's owned-directory capability:
 * exclusive no-follow creation of a private temporary, then an atomic rename. */
function writePrivate(files: CanonFiles, path: string, bytes: Buffer | null, current: CanonFileSnapshot | null): void {
  try {
    if (bytes === null) { if (current !== null) files.remove(current); return; }
    const slash = path.lastIndexOf("/"), temporary = `${path.slice(0, slash + 1)}.${path.slice(slash + 1)}.tmp`;
    const stale = files.read(temporary);
    if (stale !== null) files.remove(stale);
    const created = files.create(temporary, bytes);
    try { (current === null ? files.publish(created, path) : files.replace(created, current)).close(); }
    finally { created.close(); }
  } finally { current?.close(); }
}

function parseRecord(value: unknown): CanonStageRecoveryRecord | null {
  if (!isPlainObject(value) || value["schema"] !== RECORD_SCHEMA || !isUlid(value["id"]) || !isUlid(value["receipt_id"]) ||
      !["live", "archive"].includes(value["stage"] as string) || !["exact", "prefix", "foreign"].includes(value["classification"] as string) ||
      !["removed", "quarantined"].includes(value["action"] as string) || !["planned", "done"].includes(value["outcome"] as string) ||
      (value["quarantine_path"] !== null && typeof value["quarantine_path"] !== "string") || typeof value["at"] !== "string") return null;
  return value as unknown as CanonStageRecoveryRecord;
}
interface RecordLog { snapshot: CanonFileSnapshot | null; records: CanonStageRecoveryRecord[]; unparsed: boolean }
function readLog(files: CanonFiles): RecordLog {
  const snapshot = files.readPrivate(CANON_STAGE_RECOVERIES_PATH);
  if (snapshot === null) return { snapshot, records: [], unparsed: false };
  const records: CanonStageRecoveryRecord[] = [];
  let unparsed = false;
  try {
    for (const line of Buffer.from(snapshot.bytes).toString("utf8").split("\n")) {
      if (line.length === 0) continue;
      let record: CanonStageRecoveryRecord | null = null;
      try { record = parseRecord(JSON.parse(line)); } catch { /* Counted below. */ }
      if (record === null) unparsed = true; else records.push(record);
    }
  } catch (error) { snapshot.close(); throw error; }
  return { snapshot, records, unparsed };
}
function writeLog(files: CanonFiles, records: readonly CanonStageRecoveryRecord[], current: CanonFileSnapshot | null): void {
  const kept = records.slice(-RECORD_LIMIT);
  if (kept.length > 0) files.ensureDirectory(".kizuki/receipts");
  writePrivate(files, CANON_STAGE_RECOVERIES_PATH, kept.length === 0 ? null : Buffer.from(kept.map(item => `${JSON.stringify(item)}\n`).join("")), current);
}
function stageRecord(id: string, fields: Omit<CanonStageRecoveryRecord, "schema" | "id">): CanonStageRecoveryRecord {
  return { schema: RECORD_SCHEMA, id, receipt_id: fields.receipt_id, stage: fields.stage, classification: fields.classification,
    action: fields.action, outcome: fields.outcome, quarantine_path: fields.quarantine_path, at: fields.at };
}
/** A retry of the same unfinished action reuses its planned record. */
function planRecord(files: CanonFiles, fields: Omit<CanonStageRecoveryRecord, "schema" | "id" | "outcome">): CanonStageRecoveryRecord {
  const log = readLog(files);
  const existing = log.records.find(item => item.outcome === "planned" && item.receipt_id === fields.receipt_id && item.stage === fields.stage &&
    item.classification === fields.classification && item.action === fields.action);
  if (existing !== undefined) { log.snapshot?.close(); return existing; }
  const planned = stageRecord(ulid(), { ...fields, outcome: "planned" });
  writeLog(files, [...log.records, planned], log.snapshot);
  return planned;
}
function completeRecord(files: CanonFiles, planned: CanonStageRecoveryRecord, at: string): CanonStageRecoveryRecord {
  const log = readLog(files), done = stageRecord(planned.id, { ...planned, outcome: "done", at });
  writeLog(files, log.records.some(item => item.id === planned.id) ? log.records.map(item => item.id === planned.id ? done : item) : [...log.records, done], log.snapshot);
  return done;
}

function quarantinePath(receiptId: string, stage: CanonStageKind): string {
  return `${CANON_STAGE_QUARANTINE_PATH}/${receiptId}/${stage}.stage`;
}
function ensureQuarantine(files: CanonFiles, receiptId: string): void {
  const directory = `${CANON_STAGE_QUARANTINE_PATH}/${receiptId}`;
  try {
    files.ensureDirectory(directory);
    let prefix = "";
    for (const part of directory.split("/")) { prefix = prefix === "" ? part : `${prefix}/${part}`; files.assertPrivateDirectory(prefix); }
  } catch (error) {
    if (error instanceof CanonFilesError && (error.reason === "unsafe" || error.reason === "changed")) recoveryFailure("quarantine_unsafe", receiptId);
    throw error;
  }
}
function quarantine(files: CanonFiles, snapshot: CanonFileSnapshot, destination: string, receiptId: string): void {
  try { files.relocate(snapshot, destination).close(); }
  catch (error) {
    if (error instanceof CanonFilesError && error.reason === "conflict") recoveryFailure("quarantine_conflict", receiptId);
    if (error instanceof CanonFilesError && error.reason === "unsafe") recoveryFailure("quarantine_unsafe", receiptId);
    throw error;
  }
}

/**
 * Intent-bound stage reconciliation. Authority comes only from the
 * digest-checked durable intent: a stage whose bytes equal, or are a torn
 * prefix of, an image the intent holds loses nothing when removed. Other
 * bytes move to quarantine, or are removed when the operation is an erasure.
 * An unsafe entry holds the write untouched. Each action is recorded as
 * planned before it happens and marked done after it succeeds.
 */
export function reconcileCanonStages(files: CanonFiles, intent: CanonWriteIntent, options: { at?: string | undefined; erase?: boolean } = {}): CanonStageRecoveryRecord[] {
  const receiptId = intent.receipt.receipt_id, at = options.at ?? new Date().toISOString();
  const erase = options.erase === true || erasesStages(intent);
  const observed = observe(files, intent), records: CanonStageRecoveryRecord[] = [];
  try {
    if (observed.some(item => item.unsafe)) recoveryFailure("stage_custody_unknown", receiptId);
    for (const item of observed) {
      if (item.snapshot === null || item.classification === null || item.classification === "unsafe") continue;
      const destination = item.classification === "foreign" && !erase ? quarantinePath(receiptId, item.stage) : null;
      if (destination !== null) ensureQuarantine(files, receiptId);
      const planned = planRecord(files, { receipt_id: receiptId, stage: item.stage, classification: item.classification,
        action: destination === null ? "removed" : "quarantined", quarantine_path: destination, at });
      if (destination === null) files.remove(item.snapshot);
      else quarantine(files, item.snapshot, destination, receiptId);
      records.push(completeRecord(files, planned, at));
    }
    return records;
  } finally { for (const item of observed) { try { item.snapshot?.close(); } catch { /* Released by remove or relocate. */ } } }
}

/** A receipt whose stage traces must go: withdrawn before it committed,
 * erased, or citing an event that was purged. A pending write keeps them. */
function tracesPurged(db: Database, receiptId: string): boolean {
  if (tableExists(db, "canon_write_intents") && db.query("SELECT 1 FROM canon_write_intents WHERE receipt_id=?").get(receiptId) !== null) return false;
  const row = db.query<Record<string, unknown>, [string]>("SELECT * FROM canon_receipts WHERE receipt_id=?").get(receiptId);
  if (row === null || row["receipt_state"] === "erased") return true;
  if (!tableExists(db, "event_purges") || typeof row["provenance"] !== "string") return false;
  let provenance: unknown;
  try { provenance = JSON.parse(row["provenance"]); } catch { return false; }
  if (!Array.isArray(provenance)) return false;
  const events = provenance.filter((item): item is string => typeof item === "string").map(eventIdFromReference);
  return events.length > 0 &&
    db.query("SELECT 1 FROM event_purges WHERE event_id IN (SELECT value FROM json_each(?)) LIMIT 1").get(JSON.stringify(events)) !== null;
}
function quarantinedReceipts(vaultPath: string): string[] {
  try { return readdirSync(join(vaultPath, CANON_STAGE_QUARANTINE_PATH)).slice(0, QUARANTINE_SCAN_LIMIT).filter(isUlid); }
  catch { return []; }
}
/**
 * Stage traces follow their receipt. Once a receipt is withdrawn, erased or
 * cites purged evidence, its recovery records and quarantined bytes are
 * removed; unparsed legacy lines are dropped on the same rewrite. Idempotent.
 */
export function eraseCanonStageTraces(files: CanonFiles, db: Database, vaultPath: string): string[] {
  const log = readLog(files);
  let erased: string[];
  try {
    const candidates = new Set([...log.records.map(item => item.receipt_id), ...quarantinedReceipts(vaultPath)]);
    erased = [...candidates].filter(receiptId => tracesPurged(db, receiptId)).sort();
  } catch (error) { log.snapshot?.close(); throw error; }
  const gone = new Set(erased);
  if (erased.length > 0 || log.unparsed) writeLog(files, log.records.filter(item => !gone.has(item.receipt_id)), log.snapshot);
  else log.snapshot?.close();
  for (const receiptId of erased) {
    // An entry that is not a private regular file is never followed; it stays
    // for the owner, and doctor reports the quarantine tree as unsafe.
    try {
      for (const stage of ["live", "archive"] as const) {
        const snapshot = files.read(quarantinePath(receiptId, stage));
        if (snapshot !== null) files.remove(snapshot);
      }
      files.removeEmptyDirectory(`${CANON_STAGE_QUARANTINE_PATH}/${receiptId}`);
    } catch (error) { if (!(error instanceof CanonFilesError) || error.reason !== "unsafe") throw error; }
  }
  return erased;
}

export function readCanonStageRecoveries(vaultPath: string, receiptId?: string): CanonStageRecoveryRecord[] {
  let files: CanonFiles | undefined;
  try {
    files = openCanonFiles(vaultPath);
    const log = readLog(files);
    log.snapshot?.close();
    return log.records.filter(item => receiptId === undefined || item.receipt_id === receiptId);
  } catch { return []; }
  finally { try { files?.close(); } catch { /* Read-only view. */ } }
}

/** The quarantine tree must be private directories and files this user owns,
 * all the way down. Read-only; it follows no entry. */
export function inspectCanonQuarantine(vaultPath: string): CanonQuarantineInspection {
  const uid = process.geteuid?.();
  const owned = (path: string, kind: "directory" | "file"): boolean | null => {
    let stat;
    try { stat = lstatSync(join(vaultPath, path)); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : false; }
    return (kind === "directory" ? stat.isDirectory() && (stat.mode & 0o777) === 0o700 : stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600) &&
      (uid === undefined || stat.uid === uid);
  };
  for (const path of [".kizuki/quarantine", CANON_STAGE_QUARANTINE_PATH]) {
    const state = owned(path, "directory");
    if (state === null) return { state: "absent", files: 0 };
    if (!state) return { state: "unsafe", files: 0 };
  }
  let files = 0;
  try {
    for (const name of readdirSync(join(vaultPath, CANON_STAGE_QUARANTINE_PATH)).slice(0, QUARANTINE_SCAN_LIMIT)) {
      const directory = `${CANON_STAGE_QUARANTINE_PATH}/${name}`;
      if (owned(directory, "directory") !== true) return { state: "unsafe", files };
      for (const entry of readdirSync(join(vaultPath, directory)).slice(0, QUARANTINE_SCAN_LIMIT)) {
        if (owned(`${directory}/${entry}`, "file") !== true) return { state: "unsafe", files };
        files += 1;
      }
    }
  } catch { return { state: "unsafe", files }; }
  return { state: "private", files };
}

function parseHold(bytes: Uint8Array): CanonRecoveryHold | null {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return null; }
  if (!isPlainObject(value) || value["schema"] !== HOLD_SCHEMA || typeof value["reason"] !== "string" ||
      (value["receipt_id"] !== null && typeof value["receipt_id"] !== "string") || typeof value["at"] !== "string" ||
      !Number.isSafeInteger(value["attempts"])) return null;
  return value as unknown as CanonRecoveryHold;
}
export function readCanonRecoveryHold(vaultPath: string): CanonRecoveryHold | null {
  let files: CanonFiles | undefined;
  try {
    files = openCanonFiles(vaultPath);
    const snapshot = files.readPrivate(CANON_RECOVERY_HOLD_PATH);
    if (snapshot === null) return null;
    try { return parseHold(snapshot.bytes); } finally { snapshot.close(); }
  } catch { return null; }
  finally { try { files?.close(); } catch { /* Read-only view. */ } }
}
/** Best effort: the hold record only informs doctor and never gates recovery. */
export function recordCanonRecoveryHold(files: CanonFiles, reason: CanonRecoveryReason, receiptId: string | null, at: string = new Date().toISOString()): void {
  try {
    const current = files.readPrivate(CANON_RECOVERY_HOLD_PATH);
    let prior: CanonRecoveryHold | null = null;
    try { prior = current === null ? null : parseHold(current.bytes); } catch (error) { current?.close(); throw error; }
    const hold: CanonRecoveryHold = { schema: HOLD_SCHEMA, receipt_id: receiptId, reason, at,
      attempts: prior !== null && prior.receipt_id === receiptId && prior.reason === reason ? prior.attempts + 1 : 1 };
    writePrivate(files, CANON_RECOVERY_HOLD_PATH, Buffer.from(`${JSON.stringify(hold)}\n`), current);
  } catch { /* Doctor falls back to reading the intent. */ }
}
export function clearCanonRecoveryHold(files: CanonFiles): void {
  try {
    const current = files.readPrivate(CANON_RECOVERY_HOLD_PATH);
    if (current !== null) files.remove(current);
  } catch { /* An unwritable hold is stale; doctor ignores a hold whose receipt is no longer pending. */ }
}

/** One owner-facing next step, derived from the typed reason and stage state.
 * Only a reason that clears on its own may promise automatic completion. */
export function canonRecoveryNextStep(reason: CanonRecoveryReason | null, stages: readonly CanonStageInspection[], receiptId: string | null = null): string {
  if (stages.some(stage => stage.action_on_next_start === "hold") || reason === "stage_custody_unknown") {
    return "an entry at a canon stage path is not a private regular file; move it out of the vault, then run: kizuki recover --json";
  }
  switch (reason) {
    case "quarantine_conflict":
      return `a file already occupies this write's quarantine name under ${CANON_STAGE_QUARANTINE_PATH}/${receiptId ?? "<receipt_id>"}/; inspect it and move it out of the vault, then run: kizuki recover --json`;
    case "quarantine_unsafe":
      return `.kizuki/quarantine and every directory below it must be a directory you own with mode 0700; inside the vault run: chmod 700 .kizuki/quarantine ${CANON_STAGE_QUARANTINE_PATH} (first move any file or symlink at those names out of the vault), then run: kizuki recover --json`;
    case "receipt_stream_changed":
      return "the vault was copied at file level while a write was pending; recover at the original location, or restore from a kizuki export";
    case "receipt_stream_refused":
      return "the receipt log .kizuki/receipts/promotions.jsonl no longer matches this write's checkpoint (extra lines, changed bytes or an unsafe file) and recovery never rewrites it; restore that file from a backup taken before the write, then run: kizuki recover --json";
    case "page_changed": case "archive_changed":
      return "the page changed after the write was admitted; the write stays held and other memory stays readable. Undo or restore that edit, then run: kizuki recover --json";
    case "authority_changed": case "predecessor_changed":
      return "the write's sources or claims changed after admission; it stays held until source withdrawal or undo resolves it";
    case "intent_invalid":
      return "the pending write's durable intent fails validation and never completes on its own, while reads and ingest continue; restore the vault from a verified backup: kizuki restore --from DIR --into DIR";
    case "receipt_changed":
      return "the ledger's receipt records changed after this write was admitted (a partial restore or a manual ledger edit), so it never completes on its own; restore the vault from a verified backup: kizuki restore --from DIR --into DIR";
    case "write_refused":
      return "the canon writer refused a file operation on the page, its archive or a stage; make sure those paths are regular files and directories you own with no group or other write access, then run: kizuki recover --json";
    case "historical_orphan":
      return "the target page exists without a recorded receipt, so the writer will not overwrite it; move that page out of the vault or restore its recorded bytes, then run: kizuki recover --json";
    case "storage_full":
      return "the filesystem holding the vault is full; free space, then run: kizuki recover --json (the service also retries on its next start)";
    case "storage_refused":
      return "the filesystem refused a write (permission denied or read-only); restore your write access to the vault and its .kizuki directory, then run: kizuki recover --json";
    case "writer_busy":
      return "another kizuki process holds the canon writer; the service retries on its next rail, or run: kizuki recover --json once that process finishes";
    case "inspection_unavailable":
      return "the pending write could not be inspected; run: kizuki recover --json to retry it and report its typed reason";
    default:
      return "completes automatically on the next service start, or run: kizuki recover --json";
  }
}

export interface CanonRecoveryDetail extends CanonRecoverySummary {
  /** Typed reason from the last held attempt, or from inspecting the intent. */
  readonly reason: CanonRecoveryReason | null;
  readonly stages: CanonStageInspection[];
  readonly last_attempt: { reason: CanonRecoveryReason; at: string; attempts: number } | null;
  readonly quarantined: number;
  readonly quarantine: CanonQuarantineInspection;
  readonly stage_recoveries: CanonStageRecoveryRecord[];
  readonly next: string | null;
}
/** Read-only: classifies stages in dry-run mode and never moves an entry. */
export function inspectCanonRecoveryDetail(db: Database, vaultPath: string): CanonRecoveryDetail {
  const summary = inspectCanonRecovery(db), hold = readCanonRecoveryHold(vaultPath);
  const lastAttempt = hold !== null && summary.pending && hold.receipt_id === summary.receipt_id
    ? { reason: hold.reason, at: hold.at, attempts: hold.attempts } : null;
  let reason: CanonRecoveryReason | null = lastAttempt?.reason ?? null, stages: CanonStageInspection[] = [];
  if (summary.pending) {
    try {
      const intent = readCanonWriteIntent(db);
      if (intent !== null) {
        const files = openCanonFiles(vaultPath);
        try { stages = inspectCanonStages(files, intent); } finally { files.close(); }
      }
    } catch (error) { reason ??= error instanceof CanonRecoveryError ? error.reason : "inspection_unavailable"; }
  }
  const quarantine = inspectCanonQuarantine(vaultPath);
  return { ...summary, reason, stages, last_attempt: lastAttempt, quarantined: quarantine.files, quarantine,
    stage_recoveries: summary.receipt_id === null ? [] : readCanonStageRecoveries(vaultPath, summary.receipt_id),
    next: summary.pending ? canonRecoveryNextStep(reason, stages, summary.receipt_id) : null };
}
