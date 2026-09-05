import { sourcePolicyEpoch, sourceEventsAllowed, isLocalSourcePort, sourcePortBindingDigest } from "../ledger/source-grants";
import { createHash } from "node:crypto";
import { parseExtractResponse } from "../producer/schema";
import { invokeProducer } from "../producer/result";
import { tableExists } from "../ledger/schema";
import { isRfc3339 } from "../util/time";
import { isUlid } from "../util/ulid";
import type { Database } from "bun:sqlite";
import type { CaptureEvent } from "../contracts/event";
import type { ClaimDraft, ProduceInput, ProducerPort, QuotedEvent } from "../contracts/producer";
import { predicateIds } from "../claims/predicates";
import { historicalClaimReplaySignature, listClaims } from "../claims/store";
import type { InsertClaimInput, InsertClaimResult, PreparedClaimInsert } from "../claims/store";
import { compareRfc3339 } from "../agents/time";
import { readCheckpoint } from "../ledger/checkpoints";
import { advanceExtractCheckpoint } from "./extract-checkpoint";
import { readEvent, readSince } from "../ledger/ledger";
import type { LedgerCursor } from "../ledger/ledger";
import { validateEventOrigin, requireExternalEvents, SelfOriginError } from "../ledger/event-origin";
import { EXTRACT_BATCH, MODEL_PRODUCER_ID, planModelExtraction } from "../producer";

const EXTRACT_SOURCE_KEY = "extract";
const DEFERRED_SCAN_KEY = "extract-deferred-scan";

/** Unavailable is not empty. Only empty or a successful mine advances the cursor. */
export type ExtractMine =
  | { status: "ok"; count: number }
  | { status: "empty" }
  | { status: "deferred"; count: number }
  | { status: "unavailable"; reason: string }
  | { status: "rejected"; reason: string };

export function shouldAdvanceExtractCursor(result: ExtractMine): boolean {
  switch (result.status) {
    case "ok":
    case "empty":
    case "deferred":
      return true;
    case "unavailable":
    case "rejected":
      return false;
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

export interface MineResult {
  readonly source_epoch?: number;
  readonly mined: ExtractMine;
  readonly drafts: readonly ClaimDraft[];
  /** The checkpoint observed before the model call. */
  readonly previous_cursor: string | null;
  readonly input_ids?: readonly string[];
  readonly mode?: "frontier" | "deferred";
  readonly model_inputs?: readonly DeferredInput[];
  readonly deferred_inputs?: readonly DeferredInput[];
  /** The batch boundary that may be committed after every draft is durable. */
  readonly cursor: LedgerCursor | null;
}

export interface DurableExtractBatch {
  /** Null identifies a pre-atomic decision, retained only for storage and purge. */
  readonly filing_version: 1 | null;
  readonly previous_cursor: string | null;
  readonly cursor: LedgerCursor;
  readonly drafts: readonly ClaimDraft[];
  /** Current process view; durable drafts and their integrity stay immutable. */
  readonly filing_drafts: readonly ClaimDraft[];
  readonly model_ref: string | null;
  readonly input_ids: readonly string[];
  readonly mode: "frontier" | "deferred";
  readonly model_inputs: readonly DeferredInput[];
  readonly deferred_inputs: readonly DeferredInput[];
  readonly outcome: "ok" | "purged";
  /** Current authorization epoch captured immediately before a replay filing attempt. */
  readonly authorization_epoch: number | null;
}

export interface DeferredInput {
  readonly event_id: string;
  readonly source_key: string | null;
  readonly checked_revision: number;
  readonly checked_binding_digest: string;
}

export class DurableExtractAuthorizationError extends Error {
  override name = "DurableExtractAuthorizationError";
  readonly code = "durable_extraction_authorization_pending";
  constructor() {
    super("durable extraction authorization is pending");
  }
}

export class LegacyExtractReconciliationError extends Error {
  override name = "LegacyExtractReconciliationError";
  readonly code = "legacy_extraction_reconciliation_required";
  constructor() {
    super("Legacy extraction needs reconciliation. Preserve this vault and reconcile a separate copy; see docs/extraction-recovery.md.");
  }
}

/** A version tag is a filing contract, never a migration inferred from row contents. */
export function extractBatchFilingVersion(value: string | null): 1 | null {
  if (value === null || /^[a-f0-9]{64}$/.test(value)) return null;
  if (/^atomic-v1:[a-f0-9]{64}$/.test(value)) return 1;
  throw new Error("durable extraction filing version is corrupt or unsupported");
}

/** Refuse before any writer maintenance, claim effect, or external publication. */
export function requireAtomicExtractReplay(db: Database): void {
  if (!tableExists(db, "extract_batches")) return;
  const rows = storedExtractRows(db);
  if (rows.length > 1) throw new Error("durable extraction batch is corrupt");
  for (const row of rows) {
    if (extractBatchFilingVersion(row.integrity) === null) throw new LegacyExtractReconciliationError();
    parseStoredExtractBatch(row);
  }
}

const NULL_CURSOR = "";
const encodeCursor = (cursor: LedgerCursor): string => `${cursor.accepted_at}\t${cursor.event_id}`;
function integrity(batch: DurableExtractBatch): string {
  const hash = createHash("sha256");
  if (batch.filing_version === 1) hash.update("kizuki.extract-filing/atomic-v1\0");
  const digest = hash.update(JSON.stringify([
    batch.previous_cursor, encodeCursor(batch.cursor), batch.model_ref, batch.input_ids, batch.mode,
    batch.model_inputs, batch.deferred_inputs, batch.outcome,
    batch.drafts.map(d => [d.kind,d.subject,d.predicate,d.object,d.polarity,d.body,d.valid_from,d.valid_to,d.confidence,d.sensitivity,d.event_ids]),
  ])).digest("hex");
  return batch.filing_version === 1 ? `atomic-v1:${digest}` : digest;
}
function legacyIntegrity(batch: DurableExtractBatch): string {
  return createHash("sha256").update(JSON.stringify([
    batch.previous_cursor, encodeCursor(batch.cursor), batch.model_ref, batch.input_ids, batch.outcome,
    batch.drafts.map(d => [d.kind,d.subject,d.predicate,d.object,d.polarity,d.body,d.valid_from,d.valid_to,d.confidence,d.sensitivity,d.event_ids]),
  ])).digest("hex");
}
function observedStart(db: Database, eventIds: readonly string[]): string {
  let latest: string | undefined;
  for (const id of eventIds) {
    const event = db.query<{ observed_at: string }, [string]>(
      "SELECT observed_at FROM events WHERE event_id=?",
    ).get(id);
    if (event === null) throw new Error("produced claim source observation is unavailable");
    const observed = event.observed_at;
    let compared = compareRfc3339(observed, "source observed_at", latest ?? observed, "source observed_at");
    // The shared comparator aliases a leap second to the following second.
    // At that boundary the leap second always precedes the ordinary second,
    // regardless of either fractional part.
    const observedLeap = /:60(?:\.|[Zz+-])/.test(observed);
    if (latest !== undefined && observedLeap !== /:60(?:\.|[Zz+-])/.test(latest) &&
        compareRfc3339(observed.replace(/\.\d+/, ""), "source observed_at", latest.replace(/\.\d+/, ""), "source observed_at") === 0) {
      compared = observedLeap ? -1 : 1;
    }
    // A multi-source claim is known as of its latest supporting observation.
    // Equivalent instants use a stable original spelling, independent of citation order.
    if (latest === undefined || compared > 0 || (compared === 0 && observed < latest)) latest = observed;
  }
  if (latest === undefined) throw new Error("produced claim source observation is unavailable");
  return latest;
}

/** Materialization and historical replay authority must bind the same time. */
export function producedClaimInput(
  db: Database,
  draft: ClaimDraft,
  producer: InsertClaimInput["producer"],
  modelRef: string | null,
): InsertClaimInput {
  return {
    kind: draft.kind,
    subject: draft.subject,
    predicate: draft.predicate,
    object: draft.object,
    polarity: draft.polarity,
    body: draft.body,
    provenance: [...draft.event_ids],
    subjects: [draft.subject],
    producer,
    model_ref: modelRef,
    confidence: draft.confidence,
    taint: "quoted",
    sensitivity: draft.sensitivity,
    valid_from: draft.valid_from ?? observedStart(db, draft.event_ids),
    ...(draft.valid_to === null ? {} : { valid_to: draft.valid_to }),
  };
}
function historicalClaimSignatures(db: Database, drafts: readonly ClaimDraft[], modelRef: string | null): string[] {
  return drafts.map(draft => historicalClaimReplaySignature(producedClaimInput(db, draft, "model", modelRef)));
}
function interval(db: Database, previous: string | null, boundary: LedgerCursor): CaptureEvent[] {
  const events = readSince(db, parseCursor(previous), EXTRACT_BATCH).events;
  const index = events.findIndex(event => event.event_id === boundary.event_id);
  const row = db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id = ?").get(boundary.event_id);
  if (index < 0 || row?.accepted_at !== boundary.accepted_at) throw new Error("durable extraction boundary is invalid");
  return events.slice(0, index + 1);
}
function sourceInput(db: Database, event: CaptureEvent, producer: ProducerPort | undefined): DeferredInput {
  const binding = db.query<{ source_key: string }, [string]>(
    "SELECT source_key FROM source_event_bindings WHERE event_id=?",
  ).get(event.event_id);
  const revision = binding === null ? 0 : (db.query<{ revision: number }, [string]>(
    "SELECT revision FROM source_grants WHERE source_key=?",
  ).get(binding.source_key)?.revision ?? 0);
  return {
    event_id: event.event_id,
    source_key: binding?.source_key ?? null,
    checked_revision: revision,
    checked_binding_digest: sourcePortBindingDigest(producer),
  };
}
function sourceKey(db: Database, eventId: string): string | null {
  return db.query<{ source_key: string }, [string]>(
    "SELECT source_key FROM source_event_bindings WHERE event_id=?",
  ).get(eventId)?.source_key ?? null;
}
function sourceIdentityMatches(db: Database, input: DeferredInput): boolean {
  return sourceKey(db, input.event_id) === input.source_key;
}
function historicalEligible(event: CaptureEvent): boolean {
  return !event.deleted && !event.text.includes("KIZUKI CONTEXT v1");
}

function extractEligible(db: Database, event: CaptureEvent): boolean {
  return !event.deleted && validateEventOrigin(db, event).origin === "external";
}

function filingDrafts(db: Database, drafts: readonly ClaimDraft[]): ClaimDraft[] {
  return drafts.filter(draft => draft.event_ids.every(eventId => {
    const event = readEvent(db, eventId);
    if (event === null) throw new Error("durable extraction input is missing");
    return validateEventOrigin(db, event).origin === "external";
  }));
}
function orderedSubset(ids: readonly string[], order: ReadonlyMap<string, number>): boolean {
  let previous = -1;
  for (const id of ids) {
    const position = order.get(id);
    if (position === undefined || position <= previous) return false;
    previous = position;
  }
  return true;
}
function validateInputPartition(
  db: Database,
  mode: DurableExtractBatch["mode"],
  cursor: LedgerCursor,
  events: readonly CaptureEvent[],
  modelInputs: readonly DeferredInput[],
  deferredInputs: readonly DeferredInput[],
): void {
  const modelIds = modelInputs.map(input => input.event_id);
  const deferredIds = deferredInputs.map(input => input.event_id);
  const allInputs = [...modelInputs, ...deferredInputs];
  if (allInputs.some(input => !sourceIdentityMatches(db, input))) {
    throw new Error("durable extraction source identity is corrupt");
  }
  if (mode === "deferred") {
    const last = events.at(-1);
    const accepted = last === undefined ? null : db.query<{ accepted_at: string }, [string]>(
      "SELECT accepted_at FROM events WHERE event_id=?",
    ).get(last.event_id);
    if (deferredInputs.length > 0 || JSON.stringify(modelIds) !== JSON.stringify(events.map(event => event.event_id)) ||
        last === undefined || last.event_id !== cursor.event_id || accepted?.accepted_at !== cursor.accepted_at ||
        modelInputs.some(input => {
          return db.query(
            "SELECT 1 FROM extract_deferred_inputs WHERE event_id=?",
          ).get(input.event_id) === null;
        })) {
      throw new Error("durable extraction input partition is corrupt");
    }
    return;
  }
  const eligible = events.filter(event => !event.deleted);
  const eligibleIds = eligible.map(event => event.event_id);
  const order = new Map(eligibleIds.map((id, index) => [id, index]));
  const union = new Set([...modelIds, ...deferredIds]);
  if (union.size !== modelIds.length + deferredIds.length ||
      eligible.some(event => !union.has(event.event_id) && validateEventOrigin(db, event).origin !== "self") ||
      !orderedSubset(modelIds, order) ||
      !orderedSubset(deferredIds, order)) {
    throw new Error("durable extraction input partition is corrupt");
  }
}
function validateLegacyInputPartition(
  db: Database,
  events: readonly CaptureEvent[],
  drafts: readonly ClaimDraft[],
): void {
  const eligibleIds = events.filter(historicalEligible).map(event => event.event_id);
  const eligible = new Set(eligibleIds);
  // A null manifest is compatible only with journals written before source
  // authority existed. A managed source or native-owner marker anywhere in
  // the bounded frontier proves that this is not such a journal.
  for (const id of eligibleIds) {
    if (db.query("SELECT 1 FROM source_event_bindings WHERE event_id=?").get(id) !== null ||
        db.query("SELECT 1 FROM native_owner_evidence WHERE event_id=?").get(id) !== null) {
      throw new Error("durable extraction legacy input authority is corrupt");
    }
  }
  if (drafts.some(draft => draft.event_ids.some(id => !eligible.has(id)))) {
    throw new Error("durable extraction provenance is invalid");
  }
}
function validInput(value: unknown): value is DeferredInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(",") === "checked_binding_digest,checked_revision,event_id,source_key" &&
    typeof row.event_id === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(row.event_id) &&
    (row.source_key === null || (typeof row.source_key === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(row.source_key))) &&
    typeof row.checked_revision === "number" && Number.isSafeInteger(row.checked_revision) && row.checked_revision >= 0 &&
    typeof row.checked_binding_digest === "string" && /^[a-f0-9]{64}$/.test(row.checked_binding_digest);
}
function inputList(raw: string | null, field: string): DeferredInput[] {
  if (raw === null) return [];
  if (raw.length > 8_192 || Buffer.byteLength(raw, "utf8") > 8_192) throw new Error(`durable extraction ${field} is corrupt`);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`durable extraction ${field} is corrupt`); }
  if (!Array.isArray(value) || value.length > EXTRACT_BATCH || !value.every(validInput) ||
      new Set(value.map(item => item.event_id)).size !== value.length) {
    throw new Error(`durable extraction ${field} is corrupt`);
  }
  return value;
}
function insertDeferred(db: Database, inputs: readonly DeferredInput[]): void {
  const insert = db.query(`INSERT OR IGNORE INTO extract_deferred_inputs
    (event_id,source_key,checked_revision,checked_binding_digest) VALUES (?,?,?,?)`);
  for (const input of inputs) {
    const event = readEvent(db, input.event_id);
    if (event === null) throw new Error("deferred extraction input is missing");
    if (validateEventOrigin(db, event).origin === "self") {
      deleteDeferred(db, [input.event_id]);
    } else insert.run(input.event_id, input.source_key, input.checked_revision, input.checked_binding_digest);
  }
}
function deleteDeferred(db: Database, ids: readonly string[]): void {
  const remove = db.query("DELETE FROM extract_deferred_inputs WHERE event_id=?");
  for (const id of ids) remove.run(id);
}
function completeDeferredInputs(db: Database, inputs: readonly DeferredInput[]): void {
  deleteDeferred(db, inputs.map(input => input.event_id));
  const last = inputs.at(-1);
  if (last !== undefined) advanceExtractCheckpoint(db, DEFERRED_SCAN_KEY, last.event_id);
}
function queuedEvents(db: Database): CaptureEvent[] {
  const after = readCheckpoint(db, MODEL_PRODUCER_ID, DEFERRED_SCAN_KEY);
  const queryAfter = db.query<DeferredInput, [string, number]>(
    "SELECT event_id,source_key,checked_revision,checked_binding_digest FROM extract_deferred_inputs WHERE event_id>? ORDER BY event_id LIMIT ?",
  );
  const queryFirst = db.query<DeferredInput, [number]>(
    "SELECT event_id,source_key,checked_revision,checked_binding_digest FROM extract_deferred_inputs ORDER BY event_id LIMIT ?",
  );
  let rows = after === null ? queryFirst.all(EXTRACT_BATCH) : queryAfter.all(after, EXTRACT_BATCH);
  if (rows.length === 0 && after !== null) rows = queryFirst.all(EXTRACT_BATCH);
  return rows.map(row => {
    if (!validInput(row)) throw new Error("deferred extraction metadata is corrupt");
    const event = readEvent(db, row.event_id);
    if (event === null) throw new Error("deferred extraction event is missing");
    if (sourceInput(db, event, undefined).source_key !== row.source_key) throw new Error("deferred extraction source binding is corrupt");
    return event;
  });
}
function saveBatch(db: Database, batch: DurableExtractBatch, legacyManifest = false): void {
  db.query(`INSERT INTO extract_batches (previous_cursor,cursor,drafts,model_ref,created_at,input_ids,integrity,outcome,batch_mode,model_inputs,deferred_inputs,producer_contract,draft_schema,integrity_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'kizuki.producer/v1','kizuki.claim-draft/v1',?) ON CONFLICT(previous_cursor) DO UPDATE SET
    cursor=excluded.cursor,drafts=excluded.drafts,model_ref=excluded.model_ref,input_ids=excluded.input_ids,integrity=excluded.integrity,outcome=excluded.outcome,
    batch_mode=excluded.batch_mode,model_inputs=excluded.model_inputs,deferred_inputs=excluded.deferred_inputs,
    producer_contract=excluded.producer_contract,draft_schema=excluded.draft_schema,integrity_version=excluded.integrity_version`).run(
    batch.previous_cursor ?? NULL_CURSOR, encodeCursor(batch.cursor), JSON.stringify(batch.drafts), batch.model_ref,
    new Date().toISOString(), JSON.stringify(batch.input_ids), legacyManifest ? legacyIntegrity(batch) : integrity(batch), batch.outcome, batch.mode,
    legacyManifest ? null : JSON.stringify(batch.model_inputs), legacyManifest ? null : JSON.stringify(batch.deferred_inputs),
    batch.filing_version === 1 ? "atomic-v1" : "legacy-v1",
  );
}
/** Persist the entire decision before filing; no model is called again on replay. */
export function journalExtractBatch(db: Database, mined: MineResult, modelRef: string | null, producer?: ProducerPort): void {
  if (mined.mined.status !== "ok" || mined.cursor === null) return;
  db.transaction(() => {
    requireAtomicExtractReplay(db);
    if (mined.source_epoch !== undefined && mined.source_epoch !== sourcePolicyEpoch(db)) throw new Error("source authorization changed during extraction");
    if (readExtractCursor(db) !== mined.previous_cursor) throw new Error("extraction checkpoint changed during model call");
    const mode = mined.mode ?? "frontier";
    const events = mode === "frontier"
      ? interval(db, mined.previous_cursor, mined.cursor!)
      : (mined.model_inputs ?? []).map(input => readEvent(db, input.event_id)).filter((event): event is CaptureEvent => event !== null);
    if (mined.input_ids !== undefined && JSON.stringify(mined.input_ids) !== JSON.stringify(events.map(event => event.event_id))) throw new Error("extraction inputs changed during model call");
    const modelInputs = [...(mined.model_inputs ?? events.map(event => sourceInput(db, event, producer)))];
    if (modelInputs.length === 0 || modelInputs.length > EXTRACT_BATCH || modelInputs.some(input => {
      const event = events.find(candidate => candidate.event_id === input.event_id);
      return event === undefined || JSON.stringify(input) !== JSON.stringify(sourceInput(db, event, producer));
    })) throw new Error("source authorization changed during extraction");
    if (mode === "deferred" && modelInputs.some(input => db.query("SELECT 1 FROM extract_deferred_inputs WHERE event_id=?").get(input.event_id) === null)) {
      throw new Error("deferred extraction inputs changed during model call");
    }
    if (db.query("SELECT 1 FROM extract_batches LIMIT 1").get() !== null) throw new Error("extraction decision already pending");
    saveBatch(db, { filing_version: 1, previous_cursor: mined.previous_cursor, cursor: mined.cursor!, drafts: mined.drafts,
      filing_drafts: mined.drafts,
      model_ref: modelRef, input_ids: events.map(event => event.event_id), mode, model_inputs: modelInputs,
      deferred_inputs: [...(mined.deferred_inputs ?? [])], outcome: "ok", authorization_epoch: null });
    readDurableExtractBatch(db, producer);
  }).immediate();
}

export function readDurableExtractBatch(db: Database, producer?: ProducerPort): DurableExtractBatch | null {
  return db.transaction(() => readStoredExtractBatch(db, true, producer)).immediate();
}
interface StoredExtractRow {
  previous_cursor: string;
  cursor: string;
  drafts: string;
  model_ref: string | null;
  created_at: string;
  input_ids: string | null;
  integrity: string | null;
  outcome: string;
  batch_mode: string;
  model_inputs: string | null;
  deferred_inputs: string | null;
}

const STORED_EXTRACT_FIELDS = [
  ["previous_cursor", 256, false], ["cursor", 256, false], ["drafts", 1_600_000, false],
  ["model_ref", 2_048, true], ["created_at", 64, false], ["input_ids", 4_096, true],
  ["integrity", 74, true], ["outcome", 16, false], ["batch_mode", 16, false],
  ["model_inputs", 8_192, true], ["deferred_inputs", 8_192, true],
] as const;
const STORED_EXTRACT_METADATA = STORED_EXTRACT_FIELDS.map(([field]) =>
  `typeof(${field}) AS ${field}_type,octet_length(${field}) AS ${field}_bytes`).join(",");
const STORED_EXTRACT_BYTES = STORED_EXTRACT_FIELDS.map(([field]) => `CAST(${field} AS BLOB) AS ${field}`).join(",");

function storedExtractRows(db: Database): StoredExtractRow[] {
  // Metadata admission and payload fetch share a read snapshot. No arbitrary
  // cell is returned to Bun, decoded or sorted before its storage bounds pass.
  return db.transaction(() => {
    const metadata = db.query<Record<string, string | number | null>, []>(
      `SELECT ${STORED_EXTRACT_METADATA} FROM extract_batches LIMIT 2`,
    ).all();
    if (metadata.length > 1) throw new Error("durable extraction batch is corrupt");
    if (metadata.length === 0) return [];
    for (const [field, maxBytes, nullable] of STORED_EXTRACT_FIELDS) {
      const kind = metadata[0]![`${field}_type`];
      const size = metadata[0]![`${field}_bytes`];
      if (kind === "null" && nullable && size === null) continue;
      if (kind !== "text" || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
        throw new Error("durable extraction batch is corrupt");
      }
    }
    const rows = db.query<Record<keyof StoredExtractRow, Uint8Array | null>, []>(
      `SELECT ${STORED_EXTRACT_BYTES} FROM extract_batches LIMIT 2`,
    ).all();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    try {
      return rows.map(row => Object.fromEntries(STORED_EXTRACT_FIELDS.map(([field]) =>
        [field, row[field] === null ? null : decoder.decode(row[field]!)])) as unknown as StoredExtractRow);
    } catch {
      throw new Error("durable extraction batch is corrupt");
    }
  }).deferred();
}

function boundedStoredText(value: unknown, maxBytes: number, nullable = false): boolean {
  return (nullable && value === null) || (typeof value === "string" && value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes);
}

/** Only row bytes enter this parser: it cannot read or refresh events, sources, or ports. */
function parseStoredExtractBatch(row: StoredExtractRow): DurableExtractBatch {
  if (Object.keys(row).sort().join(",") !== "batch_mode,created_at,cursor,deferred_inputs,drafts,input_ids,integrity,model_inputs,model_ref,outcome,previous_cursor" ||
      STORED_EXTRACT_FIELDS.some(([field, maxBytes, nullable]) => !boundedStoredText(row[field], maxBytes, nullable)) ||
      !isRfc3339(row.created_at)) {
    throw new Error("durable extraction batch is corrupt");
  }
  const filingVersion = extractBatchFilingVersion(row.integrity);
  const cursor = parseCursor(row.cursor);
  const previous = row.previous_cursor === NULL_CURSOR ? null : parseCursor(row.previous_cursor);
  const validCursor = (value: LedgerCursor | null): value is LedgerCursor => value !== null && isUlid(value.event_id) && isRfc3339(value.accepted_at);
  const parsed = parseExtractResponse(`{"claims":${row.drafts}}`);
  const legacyManifest = row.model_inputs === null && row.deferred_inputs === null;
  if (!validCursor(cursor) || (row.previous_cursor !== NULL_CURSOR && !validCursor(previous)) || !parsed.ok ||
      ((row.integrity === null) !== (row.input_ids === null)) ||
      ((row.model_inputs === null || row.deferred_inputs === null) && !legacyManifest) ||
      !["ok", "purged"].includes(row.outcome) || !["frontier", "deferred"].includes(row.batch_mode) ||
      (legacyManifest && (row.batch_mode !== "frontier" || filingVersion === 1)) || (row.outcome === "ok" && parsed.claims.length === 0)) {
    throw new Error("durable extraction batch is corrupt");
  }
  const modelInputs = inputList(row.model_inputs, "model inputs");
  const deferredInputs = inputList(row.deferred_inputs, "deferred inputs");
  if ((!legacyManifest && row.outcome === "ok" && modelInputs.length === 0) || (row.batch_mode === "deferred" && deferredInputs.length > 0)) {
    throw new Error("durable extraction batch is corrupt");
  }
  let ids: string[] = [];
  if (row.input_ids !== null) {
    let decoded: unknown;
    try { decoded = JSON.parse(row.input_ids); } catch { throw new Error("durable extraction inputs changed"); }
    if (!Array.isArray(decoded) || decoded.length === 0 || decoded.length > EXTRACT_BATCH || !decoded.every(isUlid) ||
        new Set(decoded).size !== decoded.length || row.input_ids !== JSON.stringify(decoded)) {
      throw new Error("durable extraction inputs changed");
    }
    ids = decoded;
  }
  const original: DurableExtractBatch = { filing_version: filingVersion, previous_cursor: row.previous_cursor || null, cursor,
    drafts: parsed.claims, filing_drafts: [], model_ref: row.model_ref, input_ids: ids,
    mode: row.batch_mode as DurableExtractBatch["mode"], model_inputs: modelInputs, deferred_inputs: deferredInputs,
    outcome: row.outcome as DurableExtractBatch["outcome"], authorization_epoch: null };
  if (row.integrity !== null && row.integrity !== (legacyManifest ? legacyIntegrity(original) : integrity(original))) {
    throw new Error("durable extraction integrity mismatch");
  }
  if (!legacyManifest) {
    const modelIds = modelInputs.map(input => input.event_id);
    const deferredIds = deferredInputs.map(input => input.event_id);
    if (parsed.claims.some(draft => draft.event_ids.some(id => !modelIds.includes(id)))) {
      throw new Error("durable extraction provenance is invalid");
    }
    const order = new Map(ids.map((id, index) => [id, index]));
    if (row.input_ids !== null && (ids.at(-1) !== cursor.event_id ||
        new Set([...modelIds, ...deferredIds]).size !== modelIds.length + deferredIds.length ||
        !orderedSubset(modelIds, order) || !orderedSubset(deferredIds, order) ||
        (row.batch_mode === "deferred" && JSON.stringify(modelIds) !== JSON.stringify(ids)))) {
      throw new Error("durable extraction input partition is corrupt");
    }
  }
  return original;
}

function readStoredExtractBatch(db: Database, enforceConsent: boolean, producer?: ProducerPort): DurableExtractBatch | null {
  const rows = storedExtractRows(db);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("durable extraction batch is corrupt");
  const row = rows[0]!;
  if (enforceConsent && extractBatchFilingVersion(row.integrity) === null) throw new LegacyExtractReconciliationError();
  const stored = parseStoredExtractBatch(row);
  if (row.previous_cursor !== (readExtractCursor(db) ?? NULL_CURSOR)) throw new Error("durable extraction batch is corrupt");
  const { mode, cursor, model_inputs: modelInputs, deferred_inputs: deferredInputs } = stored;
  const legacyManifest = row.model_inputs === null && row.deferred_inputs === null;
  const events = mode === "frontier" ? interval(db, stored.previous_cursor, cursor) : modelInputs.map(input => {
    const event = readEvent(db, input.event_id);
    if (event === null) throw new Error("durable extraction input is missing");
    return event;
  });
  const ids = events.map(event => event.event_id);
  if (row.input_ids !== null && row.input_ids !== JSON.stringify(ids)) throw new Error("durable extraction inputs changed");
  if (legacyManifest) validateLegacyInputPartition(db, events, stored.drafts);
  else validateInputPartition(db, mode, cursor, events, modelInputs, deferredInputs);
  const sent = modelInputs.length === 0 ? [...new Set(stored.drafts.flatMap(draft => [...draft.event_ids]))] : modelInputs.map(input => input.event_id);
  if (stored.drafts.some(draft => draft.event_ids.some(id => !sent.includes(id)))) throw new Error("durable extraction provenance is invalid");
  const original = { ...stored, input_ids: ids };
  const view = filingDrafts(db, stored.drafts);
  const externalSent = sent.filter(id => {
    const event = readEvent(db, id);
    if (event === null) throw new Error("durable extraction input is missing");
    return validateEventOrigin(db, event).origin === "external";
  });
  const authorizationEpoch = enforceConsent ? sourcePolicyEpoch(db) : null;
  if (enforceConsent) {
    if (!legacyManifest && !sourceEventsAllowed(db, externalSent, {
      owner: false,
      purpose: "extract",
      model: true,
      ...(producer === undefined ? {} : { port: producer }),
    })) throw new DurableExtractAuthorizationError();
    const bindingDigest = sourcePortBindingDigest(producer);
    if (!legacyManifest && modelInputs.some(input => externalSent.includes(input.event_id) && input.checked_binding_digest !== bindingDigest)) {
      throw new DurableExtractAuthorizationError();
    }
    if (authorizationEpoch !== sourcePolicyEpoch(db)) throw new DurableExtractAuthorizationError();
  }
  // Storage validation and export never upgrade a legacy journal or mint replay
  // authority. The original nulls and bare digest remain intact on disk.
  return { ...original, filing_drafts: view, authorization_epoch: authorizationEpoch };
}

/** Validate persisted extraction recovery state without invoking a producer or filing canon. */
export function validateDurableExtractStorage(db: Database): void {
  readStoredExtractBatch(db, false);
}

function matchingDurableBatch(db: Database, batch: DurableExtractBatch, producer?: ProducerPort): DurableExtractBatch | null {
  requireAtomicExtractReplay(db);
  if (batch.filing_version !== 1) throw new LegacyExtractReconciliationError();
  if (batch.authorization_epoch === null || batch.authorization_epoch !== sourcePolicyEpoch(db)) {
    throw new DurableExtractAuthorizationError();
  }
  const current = readDurableExtractBatch(db, producer);
  return current !== null && integrity(current) === integrity(batch) &&
    JSON.stringify(current.filing_drafts) === JSON.stringify(batch.filing_drafts) ? current : null;
}

function finishDurableBatch(db: Database, batch: DurableExtractBatch): void {
  insertDeferred(db, batch.deferred_inputs);
  if (batch.mode === "frontier") advanceExtractCheckpoint(db, EXTRACT_SOURCE_KEY, encodeCursor(batch.cursor));
  else completeDeferredInputs(db, batch.model_inputs);
  db.query("DELETE FROM extract_batches WHERE previous_cursor = ?").run(batch.previous_cursor ?? NULL_CURSOR);
}

/** Complete an already handled decision; extraction filing uses the atomic operation below. */
export function completeDurableExtractBatch(db: Database, batch: DurableExtractBatch, producer?: ProducerPort): boolean {
  return db.transaction(() => {
    const current = matchingDurableBatch(db, batch, producer);
    if (current === null) return false;
    finishDurableBatch(db, current);
    return true;
  }).immediate();
}

/** All claim effects, outbox rows and decision completion share one durable commit. */
export function fileAndCompleteDurableExtractBatch(
  db: Database,
  batch: DurableExtractBatch,
  producer: ProducerPort,
  prepared: readonly PreparedClaimInsert[],
): InsertClaimResult[] | null {
  if (db.inTransaction) throw new Error("extraction filing requires a top-level transaction");
  return db.transaction(() => {
    const current = matchingDurableBatch(db, batch, producer);
    if (current === null) return null;
    const signatures = historicalClaimSignatures(db, current.filing_drafts, current.model_ref);
    if (prepared.length !== signatures.length || prepared.some((operation, index) =>
      operation.db !== db || operation.signature !== signatures[index])) {
      throw new Error("prepared extraction drafts do not match the durable decision");
    }
    const results = prepared.map(operation => operation.apply());
    // A changed final fence must throw so every prior effect rolls back too.
    if (matchingDurableBatch(db, current, producer) === null) throw new Error("extract decision changed during filing");
    finishDurableBatch(db, current);
    return results;
  }).immediate();
}

/** Called inside the source purge transaction, before deleting ledger rows. */
export function purgeExtractInputs(db: Database, eventIds: ReadonlySet<string>, purge: { receipt_id: string; created_at: string }): void {
  if (tableExists(db, "extract_deferred_inputs")) deleteDeferred(db, [...eventIds]);
  if (!tableExists(db, "extract_batches")) return;
  let batch: DurableExtractBatch | null;
  let legacyManifest = false;
  let unhashedLegacy = false;
  try {
    const stored = db.query<{ legacy_manifest: number; unhashed: number }, []>(
      "SELECT model_inputs IS NULL AND deferred_inputs IS NULL AS legacy_manifest,integrity IS NULL AS unhashed FROM extract_batches LIMIT 1",
    ).get();
    legacyManifest = stored?.legacy_manifest === 1;
    unhashedLegacy = stored?.unhashed === 1;
    batch = readStoredExtractBatch(db, false);
  } catch {
    // Derived decisions cannot veto an owner purge. Do not parse or preserve
    // corrupt content; the source transaction also commits this audit marker.
    db.query("DELETE FROM extract_batches").run();
    db.query("INSERT INTO extract_invalidations(purge_receipt_id,reason,created_at) VALUES (?, 'invalid_derived_journal', ?)").run(purge.receipt_id, purge.created_at);
    batch = null;
  }
  const previous = readExtractCursor(db);
  const previousBoundary = parseCursor(previous);
  let nextPrevious = previous;
  if (previousBoundary !== null && eventIds.has(previousBoundary.event_id)) {
    const candidates = db.query<{ event_id: string; accepted_at: string }, [string, string, string]>(
      "SELECT event_id,accepted_at FROM events WHERE accepted_at < ? OR (accepted_at = ? AND event_id <= ?) ORDER BY accepted_at DESC,event_id DESC",
    ).all(previousBoundary.accepted_at, previousBoundary.accepted_at, previousBoundary.event_id);
    const surviving = candidates.find(row => !eventIds.has(row.event_id));
    nextPrevious = surviving === undefined ? null : encodeCursor(surviving);
    if (nextPrevious === null) db.query("DELETE FROM checkpoints WHERE connector_id=? AND source_key=?").run(MODEL_PRODUCER_ID, EXTRACT_SOURCE_KEY);
    else advanceExtractCheckpoint(db, EXTRACT_SOURCE_KEY, nextPrevious);
  }
  if (batch === null) return;
  if (!batch.input_ids.some(id => eventIds.has(id)) && !batch.deferred_inputs.some(input => eventIds.has(input.event_id)) && nextPrevious === previous) return;
  const remaining = batch.input_ids.filter(id => !eventIds.has(id));
  db.query("DELETE FROM extract_batches").run();
  if (remaining.length === 0) return;
  const last = remaining.at(-1)!;
  const row = db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id = ?").get(last)!;
  saveBatch(db, { ...batch, previous_cursor: nextPrevious, input_ids: remaining, cursor: { event_id: last, accepted_at: row.accepted_at },
    model_inputs: batch.model_inputs.filter(input => !eventIds.has(input.event_id)),
    deferred_inputs: batch.deferred_inputs.filter(input => !eventIds.has(input.event_id)),
    drafts: batch.drafts.filter(draft => !draft.event_ids.some(id => eventIds.has(id))),
    filing_drafts: [], outcome: "purged",
    authorization_epoch: null }, legacyManifest);
  if (unhashedLegacy) {
    db.query("UPDATE extract_batches SET input_ids=NULL,integrity=NULL,integrity_version='legacy-v1' WHERE previous_cursor=?").run(nextPrevious ?? NULL_CURSOR);
  }
}

function parseCursor(raw: string | null): LedgerCursor | null {
  if (raw === null || raw.length === 0) return null;
  const split = raw.indexOf("\t");
  if (split <= 0 || split === raw.length - 1) return null;
  return {
    accepted_at: raw.slice(0, split),
    event_id: raw.slice(split + 1),
  };
}

function quoted(event: CaptureEvent): QuotedEvent {
  return {
    event_id: event.event_id,
    connector_id: event.connector_id,
    occurred_at: event.occurred_at,
    observed_at: event.observed_at,
    text: event.text,
    subjects: event.subjects,
    taint: "untrusted",
  };
}

export function readExtractCursor(db: Database): string | null {
  return readCheckpoint(db, MODEL_PRODUCER_ID, EXTRACT_SOURCE_KEY);
}

/**
 * Commit only the boundary that was read before the model call. A concurrent
 * extraction pass may have advanced the checkpoint while this pass was filing
 * drafts; in that case this pass leaves it alone and its idempotent drafts can
 * be retried safely.
 */
export function commitExtractCursor(db: Database, mined: MineResult): boolean {
  if (!shouldAdvanceExtractCursor(mined.mined) || mined.cursor === null) return false;
  const boundary = mined.cursor;
  return db.transaction(() => {
    requireAtomicExtractReplay(db);
    if (mined.source_epoch !== undefined && mined.source_epoch !== sourcePolicyEpoch(db)) throw new Error("source authorization changed during extraction");
    if (readExtractCursor(db) !== mined.previous_cursor) return false;
    const mode = mined.mode ?? "frontier";
    const events = mode === "frontier" ? interval(db, mined.previous_cursor, boundary) : (mined.model_inputs ?? []).map(input => {
      const event = readEvent(db, input.event_id);
      if (event === null) throw new Error("deferred extraction input is missing");
      return event;
    });
    if (mined.input_ids !== undefined && JSON.stringify(mined.input_ids) !== JSON.stringify(events.map(event => event.event_id))) return false;
    if (mode === "deferred") {
      const inputs = mined.model_inputs ?? [];
      if (inputs.some(input => db.query("SELECT 1 FROM extract_deferred_inputs WHERE event_id=?").get(input.event_id) === null)) return false;
      completeDeferredInputs(db, inputs);
    } else {
      insertDeferred(db, mined.deferred_inputs ?? []);
      advanceExtractCheckpoint(db, EXTRACT_SOURCE_KEY, encodeCursor(boundary));
    }
    return true;
  }).immediate();
}

/**
 * Session/outcome mine. Unavailable or rejected never advances the cursor
 * (None ≠ []). Empty and ok do.
 */
export async function mineLiveDrafts(
  db: Database,
  producer: ProducerPort,
): Promise<MineResult> {
  requireAtomicExtractReplay(db);
  const previous_cursor = readExtractCursor(db);
  const source_epoch = sourcePolicyEpoch(db);
  const denied = (): MineResult => ({ mined: { status: "unavailable", reason: "source authorization unavailable" }, drafts: [], previous_cursor, cursor: null });
  if (source_epoch > 0 && !isLocalSourcePort(producer) && !sourceEventsAllowed(db, [], { owner: false, purpose: "extract", model: true, port: producer })) return denied();
  const scope = { owner: false, purpose: "extract" as const, model: true, port: producer };
  let mode: "frontier" | "deferred" = "frontier";
  let cursor: LedgerCursor | null = null;
  let inputIds: string[] = [];
  let modelInputs: DeferredInput[] = [];
  let deferredInputs: DeferredInput[] = [];
  let usable: CaptureEvent[] = [];
  let frontierEvents: readonly CaptureEvent[] = [];

  const queued = db.transaction(() => {
    const candidates = queuedEvents(db);
    const eligible: CaptureEvent[] = [];
    for (const event of candidates) {
      if (extractEligible(db, event)) eligible.push(event);
      else deleteDeferred(db, [event.event_id]);
    }
    return eligible;
  }).immediate();
  if (queued.length > 0) {
    usable = queued.filter(event => sourceEventsAllowed(db, [event.event_id], scope));
    const held = queued.filter(event => !usable.some(candidate => candidate.event_id === event.event_id));
    db.transaction(() => {
      if (sourcePolicyEpoch(db) !== source_epoch) throw new Error("source authorization changed during extraction");
      const update = db.query(`UPDATE extract_deferred_inputs SET source_key=?,checked_revision=?,checked_binding_digest=? WHERE event_id=?`);
      for (const event of held) {
        const input = sourceInput(db, event, producer);
        update.run(input.source_key, input.checked_revision, input.checked_binding_digest, input.event_id);
      }
      // A denied-only page may rotate. A selected page advances its scan only
      // when the exact processed prefix is durably removed from the queue.
      if (usable.length === 0) advanceExtractCheckpoint(db, DEFERRED_SCAN_KEY, queued.at(-1)!.event_id);
    }).immediate();
    if (usable.length > 0) {
      mode = "deferred";
      inputIds = usable.map(event => event.event_id);
      modelInputs = usable.map(event => sourceInput(db, event, producer));
      const last = usable.at(-1)!;
      const row = db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id=?").get(last.event_id);
      if (row === null) throw new Error("deferred extraction input is missing");
      cursor = { event_id: last.event_id, accepted_at: row.accepted_at };
    }
  }

  if (usable.length === 0) {
    const batch = readSince(db, parseCursor(previous_cursor), EXTRACT_BATCH);
    if (batch.events.length === 0 || batch.cursor === null) {
      return { mined: { status: "empty" }, drafts: [], previous_cursor, cursor: null };
    }
    cursor = batch.cursor;
    frontierEvents = batch.events;
    inputIds = batch.events.map(event => event.event_id);
    // Packet text that later lands in the ledger is history, not extract input.
    const eligible = db.transaction(() =>
      batch.events.filter(event => extractEligible(db, event)),
    ).immediate();
    usable = eligible.filter(event => sourceEventsAllowed(db, [event.event_id], scope));
    modelInputs = usable.map(event => sourceInput(db, event, producer));
    deferredInputs = source_epoch === 0 ? [] : eligible
      .filter(event => !usable.some(candidate => candidate.event_id === event.event_id))
      .map(event => sourceInput(db, event, producer));
    if (usable.length === 0 && source_epoch > 0) {
      return { source_epoch, mined: { status: "deferred", count: deferredInputs.length }, drafts: [],
        previous_cursor, cursor, input_ids: inputIds, mode, model_inputs: [], deferred_inputs: deferredInputs };
    }
    if (usable.length === 0) {
      return { source_epoch, mined: { status: "empty" }, drafts: [], previous_cursor, cursor,
        input_ids: inputIds, mode, model_inputs: [], deferred_inputs: [] };
    }
  }

  const knownBySubject = new Map<string, ReturnType<typeof listClaims>>();
  const inputFor = (events: readonly CaptureEvent[]): ProduceInput => {
    const subjects = new Set(events.flatMap(event => event.subjects.map(subject => subject.subject_id)));
    // Select context for this prefix before applying the shared cap. A full
    // batch's capped context may omit the subjects the prefix actually needs.
    const known = [...subjects].sort().flatMap(subject => {
      let claims = knownBySubject.get(subject);
      if (claims === undefined) {
        claims = listClaims(db, { status: "live", keyed: true, subject, limit: 32,
          filter: claim => {
            if (!sourceEventsAllowed(db, claim.provenance, scope)) return false;
            try { requireExternalEvents(db, claim.provenance); return true; }
            catch (error) { if (!(error instanceof SelfOriginError)) throw error; return false; }
          } });
        knownBySubject.set(subject, claims);
      }
      return claims;
    }).slice(0, 32);
    return { events: events.map(quoted), context: { subjects: events.flatMap(event => event.subjects),
      known_claims: known.map(claim => ({ claim_id: claim.claim_id, subject: claim.subject, predicate: claim.predicate,
        object: claim.object, polarity: claim.polarity, confidence: claim.confidence })), predicates: [...predicateIds()] },
      budget: { max_calls: 2, max_input_tokens: 8_000, max_output_tokens: 2_000 } };
  };
  // Keep an impossible first record on the ordinary observed-producer path:
  // native preflight will publish an exact zero-call refusal, never a drop.
  let selectedCount = 1;
  let selectedInput = inputFor(usable.slice(0, 1));
  for (let count = 1; count <= usable.length; count++) {
    const candidate = count === 1 ? selectedInput : inputFor(usable.slice(0, count));
    const plan = planModelExtraction(candidate);
    // Capped context can change when a subject is added, so inspect every
    // prefix instead of assuming prompt size grows monotonically.
    if (plan.status === "ready" && plan.calls.length === 1) { selectedCount = count; selectedInput = candidate; }
  }
  if (selectedCount < usable.length) {
    usable = usable.slice(0, selectedCount);
    modelInputs = modelInputs.slice(0, selectedCount);
    const last = usable.at(-1)!;
    const accepted = db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id=?").get(last.event_id);
    if (accepted === null) throw new Error("extraction prefix input is missing");
    cursor = { event_id: last.event_id, accepted_at: accepted.accepted_at };
    inputIds = mode === "frontier"
      ? frontierEvents.slice(0, frontierEvents.findIndex(event => event.event_id === last.event_id) + 1).map(event => event.event_id)
      : usable.map(event => event.event_id);
    const included = new Set(inputIds);
    deferredInputs = deferredInputs.filter(input => included.has(input.event_id));
  }
  const admitted = db.transaction(() => usable.filter(event => extractEligible(db, event))).immediate();
  if (admitted.length !== usable.length) {
    return { mined: { status: "unavailable", reason: "event origin changed before extraction" }, drafts: [], previous_cursor, cursor: null };
  }
  selectedInput = inputFor(usable);
  const selectedIds = new Set(usable.map(event => event.event_id));
  if (source_epoch !== sourcePolicyEpoch(db)) return denied();
  const { result: produced } = await invokeProducer(producer, selectedInput);

  if (source_epoch !== sourcePolicyEpoch(db)) return denied();
  usable = db.transaction(() => usable.filter(event => extractEligible(db, event))).immediate();
  if (usable.length === 0) {
    return { source_epoch, mined: { status: "empty" }, drafts: [], previous_cursor, cursor,
      input_ids: inputIds, mode, model_inputs: modelInputs, deferred_inputs: deferredInputs };
  }
  if (produced.status === "ok" && produced.claims.some(draft => draft.event_ids.some(id => !selectedIds.has(id)))) return denied();
  let mined: ExtractMine;
  let drafts: readonly ClaimDraft[] = [];
  switch (produced.status) {
    case "unavailable":
      mined = { status: "unavailable", reason: produced.reason };
      break;
    case "rejected":
      mined = { status: "rejected", reason: produced.reason };
      break;
    case "ok":
      drafts = produced.claims.filter(draft => draft.event_ids.every(id =>
        usable.some(event => event.event_id === id),
      ));
      mined =
        drafts.length === 0
          ? { status: "empty" }
          : { status: "ok", count: drafts.length };
      break;
    default: {
      const _exhaustive: never = produced;
      return _exhaustive;
    }
  }

  return { source_epoch, mined, drafts, previous_cursor, cursor, input_ids: inputIds,
    mode, model_inputs: modelInputs, deferred_inputs: deferredInputs };
}
