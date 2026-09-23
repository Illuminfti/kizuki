import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { CanonFilesError, openCanonFiles, type CanonFiles, type CanonFileSnapshot } from "../vault/canon-files";
import { hashBytes } from "../vault/write";
import { isPlainObject } from "../util/validate";
import { CanonRecoveryError, decodeCanonImage, inspectCanonRecovery, readCanonWriteIntent, recoveryFailure, type CanonRecoveryReason, type CanonRecoverySummary, type CanonWriteIntent } from "./write-intent";

/** Append-only record of every stage recovery touched, written before acting. */
export const CANON_STAGE_RECOVERIES_PATH = ".kizuki/receipts/stage-recoveries.jsonl";
/** Foreign stage bytes are moved here, never deleted. */
export const CANON_STAGE_QUARANTINE_PATH = ".kizuki/quarantine/canon-stage";
/** Last held recovery attempt, for doctor. Rewritten atomically; not a receipt. */
export const CANON_RECOVERY_HOLD_PATH = ".kizuki/canon-recovery-hold.json";
const RECORD_SCHEMA = "kizuki.canon-stage-recovery/v1";
const HOLD_SCHEMA = "kizuki.canon-recovery-hold/v1";
const CLOSE_ON_EXEC = process.platform === "darwin" ? 0x1000000 : 0x80000;

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
  readonly receipt_id: string;
  readonly stage: CanonStageKind;
  readonly path: string;
  readonly classification: "exact" | "prefix" | "foreign";
  readonly bytes: number;
  readonly sha256: string;
  readonly expected_sha256: string | null;
  readonly action: "removed" | "quarantined";
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
  const observed = observe(files, intent);
  try {
    return observed.map(item => ({
      stage: item.stage, path: item.path, present: item.snapshot !== null || item.unsafe,
      classification: item.classification, bytes: item.bytes?.length ?? null,
      sha256: item.bytes === null ? null : hashBytes(item.bytes),
      expected_sha256: item.expected === null ? null : hashBytes(item.expected),
      action_on_next_start: item.unsafe ? "hold" : item.classification === null ? "none" :
        item.classification === "foreign" ? "quarantine" : "remove",
    }));
  } finally { for (const item of observed) item.snapshot?.close(); }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOSE_ON_EXEC);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function appendRecord(vaultPath: string, record: CanonStageRecoveryRecord): void {
  const path = join(vaultPath, CANON_STAGE_RECOVERIES_PATH);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | CLOSE_ON_EXEC, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid!() || (stat.mode & 0o077) !== 0) {
      recoveryFailure("stage_custody_unknown", record.receipt_id);
    }
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    for (let offset = 0; offset < line.length;) offset += writeSync(fd, line, offset, line.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
function ensureQuarantine(files: CanonFiles, receiptId: string): string {
  const directory = `${CANON_STAGE_QUARANTINE_PATH}/${receiptId}`;
  files.ensureDirectory(directory);
  let prefix = "";
  for (const part of directory.split("/")) { prefix = prefix === "" ? part : `${prefix}/${part}`; files.assertPrivateDirectory(prefix); }
  return directory;
}

/**
 * Intent-bound stage reconciliation. Authority comes only from the
 * digest-checked durable intent: a stage whose bytes equal, or are a torn
 * prefix of, an image the intent holds loses nothing when removed. Any other
 * bytes move to quarantine. An unsafe entry holds the write untouched. Each
 * action is durably recorded before it happens.
 */
export function reconcileCanonStages(files: CanonFiles, vaultPath: string, intent: CanonWriteIntent, at: string = new Date().toISOString()): CanonStageRecoveryRecord[] {
  const observed = observe(files, intent), records: CanonStageRecoveryRecord[] = [];
  try {
    if (observed.some(item => item.unsafe)) recoveryFailure("stage_custody_unknown", intent.receipt.receipt_id);
    for (const item of observed) {
      if (item.snapshot === null || item.bytes === null || item.classification === null || item.classification === "unsafe") continue;
      const sha256 = hashBytes(item.bytes);
      const quarantine = item.classification === "foreign" ? `${ensureQuarantine(files, intent.receipt.receipt_id)}/${item.stage}-${sha256}.stage` : null;
      const record: CanonStageRecoveryRecord = {
        schema: RECORD_SCHEMA, receipt_id: intent.receipt.receipt_id, stage: item.stage, path: item.path,
        classification: item.classification, bytes: item.bytes.length, sha256,
        expected_sha256: item.expected === null ? null : hashBytes(item.expected),
        action: quarantine === null ? "removed" : "quarantined", quarantine_path: quarantine, at,
      };
      appendRecord(vaultPath, record);
      if (quarantine === null) files.remove(item.snapshot);
      else {
        try { files.relocate(item.snapshot, quarantine).close(); }
        catch (error) {
          if (error instanceof CanonFilesError && error.reason === "conflict") recoveryFailure("stage_custody_unknown", intent.receipt.receipt_id);
          throw error;
        }
      }
      records.push(record);
    }
    return records;
  } finally { for (const item of observed) { try { item.snapshot?.close(); } catch { /* Released by remove or relocate. */ } } }
}

function parseRecord(value: unknown): CanonStageRecoveryRecord | null {
  if (!isPlainObject(value) || value["schema"] !== RECORD_SCHEMA || typeof value["receipt_id"] !== "string" ||
      !["live", "archive"].includes(value["stage"] as string) || typeof value["path"] !== "string" ||
      !["exact", "prefix", "foreign"].includes(value["classification"] as string) || !Number.isSafeInteger(value["bytes"]) ||
      typeof value["sha256"] !== "string" || !["removed", "quarantined"].includes(value["action"] as string) ||
      typeof value["at"] !== "string") return null;
  return value as unknown as CanonStageRecoveryRecord;
}
export function readCanonStageRecoveries(vaultPath: string, receiptId?: string): CanonStageRecoveryRecord[] {
  const path = join(vaultPath, CANON_STAGE_RECOVERIES_PATH);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  return text.split("\n").flatMap(line => {
    if (line.length === 0) return [];
    let value: unknown;
    try { value = JSON.parse(line); } catch { return []; }
    const record = parseRecord(value);
    return record === null || (receiptId !== undefined && record.receipt_id !== receiptId) ? [] : [record];
  });
}
/** Quarantined stage files awaiting the owner's inspection. */
export function countQuarantinedCanonStages(vaultPath: string): number {
  const root = join(vaultPath, CANON_STAGE_QUARANTINE_PATH);
  let total = 0;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) { total += 1; continue; }
      total += readdirSync(join(root, entry.name)).length;
    }
  } catch { return 0; }
  return total;
}

export function readCanonRecoveryHold(vaultPath: string): CanonRecoveryHold | null {
  const path = join(vaultPath, CANON_RECOVERY_HOLD_PATH);
  try {
    if (!lstatSync(path).isFile()) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(value) || value["schema"] !== HOLD_SCHEMA || typeof value["reason"] !== "string" ||
        (value["receipt_id"] !== null && typeof value["receipt_id"] !== "string") || typeof value["at"] !== "string" ||
        !Number.isSafeInteger(value["attempts"])) return null;
    return value as unknown as CanonRecoveryHold;
  } catch { return null; }
}
/** Best effort: the hold record only informs doctor and never gates recovery. */
export function recordCanonRecoveryHold(vaultPath: string, reason: CanonRecoveryReason, receiptId: string | null, at: string = new Date().toISOString()): void {
  const prior = readCanonRecoveryHold(vaultPath);
  const hold: CanonRecoveryHold = { schema: HOLD_SCHEMA, receipt_id: receiptId, reason, at,
    attempts: prior !== null && prior.receipt_id === receiptId && prior.reason === reason ? prior.attempts + 1 : 1 };
  const path = join(vaultPath, CANON_RECOVERY_HOLD_PATH), temporary = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | CLOSE_ON_EXEC, 0o600);
    try { writeSync(fd, `${JSON.stringify(hold)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } catch { try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* Best effort. */ } }
}
export function clearCanonRecoveryHold(vaultPath: string): void {
  try { unlinkSync(join(vaultPath, CANON_RECOVERY_HOLD_PATH)); } catch { /* Absent or unwritable; doctor ignores a stale receipt id. */ }
}

/** One owner-facing next step, derived from the typed reason and stage state. */
export function canonRecoveryNextStep(reason: CanonRecoveryReason | null, stages: readonly CanonStageInspection[]): string {
  if (stages.some(stage => stage.action_on_next_start === "hold") || reason === "stage_custody_unknown") {
    return "an entry at a canon stage path is not a private regular file; move it out of the vault, then run: kizuki recover --json";
  }
  switch (reason) {
    case "receipt_stream_changed":
      return "the vault was copied at file level while a write was pending; recover at the original location, or restore from a kizuki export";
    case "page_changed": case "archive_changed":
      return "the page changed after the write was admitted; the write stays held and other memory stays readable. Undo or restore that edit, then run: kizuki recover --json";
    case "authority_changed": case "predecessor_changed":
      return "the write's sources or claims changed after admission; it stays held until source withdrawal or undo resolves it";
    default:
      return "completes automatically on the next service start, or run: kizuki recover --json";
  }
}

export interface CanonRecoveryDetail extends CanonRecoverySummary {
  /** Typed reason from the last held attempt, or from reading the intent. */
  readonly reason: CanonRecoveryReason | null;
  readonly stages: CanonStageInspection[];
  readonly last_attempt: { reason: CanonRecoveryReason; at: string; attempts: number } | null;
  readonly quarantined: number;
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
    } catch (error) { if (error instanceof CanonRecoveryError) reason ??= error.reason; }
  }
  return { ...summary, reason, stages, last_attempt: lastAttempt, quarantined: countQuarantinedCanonStages(vaultPath),
    stage_recoveries: summary.receipt_id === null ? [] : readCanonStageRecoveries(vaultPath, summary.receipt_id),
    next: summary.pending ? canonRecoveryNextStep(reason, stages) : null };
}
