import { attentionDoctor } from "./doctor-attention";
import { consolidationDoctor } from "./doctor-consolidation";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { loadConfiguredRetrieval, readRetrievalEngineRefusal } from "../retrieval/config";
import { eventIdFromReference } from "../retrieval/ids";
import { embeddingThroughputFromReceipts } from "../retrieval/reembed";
import { inspectPageIndex } from "../canon";
import { CanonAuthorityResolver, type CanonRevisionBasis } from "../canon/authority";
import { assertReceiptPaths } from "../canon/paths";
import { staleCanonIntentFailure } from "./canon-intent-health";
import { isMachineOriginPath } from "../canon/origin";
import { EVENT_LIMITS, EVENT_SCHEMA } from "../contracts/event";
import { isAuthorityTier, type AuthorityTier } from "../contracts/proposal";
import { formatProducerDiagnostic } from "../producer/diagnostics";
import { SINGLE_SOURCE_CAP } from "../claims/authority";
import { countPendingRetrievalOps } from "../claims/store";
import { derivedPageSkips } from "../derived-health";
import { readDerivedMeta } from "../derived-meta";
import { readDerivedHolds } from "../derived-holds";
import { inspectConnectionStateRecovery } from "../ledger/connection-state";
import { inspectCheckpoints, inspectConnections } from "../ledger/connections";
import { nativeRequestDigest } from "../ledger/event-origin-binding";
import { eventFromRow, validateEventRecord, type EventRow } from "../ledger/event-record";
import { LIVE_PREDICATE } from "../ledger/ledger";
import { tableExists } from "../ledger/schema";
import { inspectSourceGrant, sourceEventsAllowed, sourcePolicyEpoch, type SourceGrant } from "../ledger/source-grants";
import { inspectPurgeHealth } from "../ledger/purge";
import { isRfc3339 } from "../util/time";
import { utf8ByteLength } from "../util/validate";
import { canonCapacity, loadCanonLimits } from "../vault/canon-limits";
import { isLiveCanonPage, listCanonPagesReport, type CanonPage, type CanonPageReport } from "../vault/pages";
import { assessLivePageEvidence, isDeterministicBrief, type PageAssessment, type WalkEvidence } from "../vault/provenance";
import { parsePageSources } from "../vault/schema";
import { loadConfiguredModelRef, loadEmbeddingSelection, loadServeConfig, type EmbeddingSelection } from "./config";
import { ageSeconds, railDoctor, syncPassWait } from "./doctor-rails";
import { egressDoctor, extractionDoctor } from "./doctor-extraction";
import { readServeIntent } from "./intent";
import { serviceFile } from "./service-files";
import { isRedactedModelReference, listRunReceipts, orphanJournalReceipts, readEmbeddingReceipts, readModelRunHistory, readPendingRunReceipts, redactReceiptText, type ModelRunHistory } from "./receipts";
import { sha256Hex } from "../util/hash";
import { listRails } from "./rail-registry";
import { listSchedules } from "./schema";
import { countOversizedRecords, RETRY_SKIPPED_COMMAND } from "./extract-oversized";
import { listQuarantinedPages, listQuarantinedClaims } from "./write-quarantine";
import type { SupervisorHost } from "./supervisor";
import { queryServeService } from "./supervisor";
import { ensureVaultId } from "./vault-id";
import {
  CALIBRATION_BAND,
  CONFIDENCE_SPREAD_MIN,
  DOCTOR_RAIL_RECEIPTS,
  DOCTOR_SKIPPED_PAGES,
  DOCTOR_SYNC_RECEIPTS,
  RETRIEVAL_SLA_SECONDS,
  RUN_RECEIPT_RETENTION_DAYS,
  type CalibrationBandsReason,
  type CalibrationDoctor,
  type ModelDoctor,
  type RailId,
  type RunReceipt,
  type ServeConfig,
  type ServeDoctorReport,
  type ServeIntent,
  type StoreDoctor,
  type TopFailure,
  type SupervisorLastExit,
  type ThroughputDoctor,
  type OversizedDoctor,
  type QuarantineDoctor,
  type SupervisorStatus,
} from "./types";

export interface ServeDoctorOptions {
  readonly now?: string;
  readonly supervisor?: SupervisorHost;
  readonly model_ref?: string | null;
  /** The bound port's owner-configured reasoning effort; null sends none. */
  readonly reasoning_effort?: string | null;
  /**
   * The configured model's reference as its port builds it, host included, so
   * the daemon's receipts can be matched from a process that cannot bind the
   * model. Raw config intent is shown as unverified until a host binds its port.
   */
  readonly configured_model_ref?: string | null;
  /** True when an embedding port is configured; only then does embed-backfill have work to judge. */
  readonly embedding_configured?: boolean;
  /** The destination a configured System One judge sends extraction text to; each egress line then says whether its grant consents to it. */
  readonly judge?: { readonly model_endpoint: string; readonly model: string } | null;
  /**
   * False skips the walk of every canon page. The walk parses each page, so a
   * caller inside the daemon's event loop or one that reads a single field
   * turns it off; the skipped-page and origin fields are then empty. Defaults
   * to true.
   */
  readonly page_walk?: boolean;
  /**
   * Pre-walked canon page report to reuse when the caller already scanned the
   * vault in the same doctor pass, avoiding duplicate directory walks.
   */
  readonly pages?: CanonPageReport;
  /**
   * False when the caller runs inside the service: its supervisor, intent and
   * liveness are the service's own to know, so they are neither checked nor a
   * failure. Defaults to true.
   */
  readonly host_checks?: boolean;
}

function stdev(values: number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function policyCapped(row: {
  confidence: number;
  provenance: string;
  corroboration: number;
  authority: string;
}): boolean {
  if (row.authority !== "model_inference" || row.corroboration > 1) return false;
  if (row.confidence !== SINGLE_SOURCE_CAP) return false;
  try {
    const provenance: unknown = JSON.parse(row.provenance);
    return Array.isArray(provenance) && provenance.length === 1;
  } catch {
    return false;
  }
}

/**
 * Minimum extracted drafts before a keep rate is a control rather than
 * noise. Mirrors the confidence-spread sample floor below.
 */
const MIN_CALIBRATION_SAMPLE = 8;

/** The clock a first fill is judged against, or why there is not one. */
type ExtractingClock =
  | { readonly kind: "none" }
  | { readonly kind: "unparseable" }
  | { readonly kind: "at"; readonly started_at: string };

function latestExtractingStartedAt(receipts: RunReceipt[]): ExtractingClock {
  let startedAt: string | null = null;
  let latest = Number.NEGATIVE_INFINITY;
  for (const receipt of receipts) {
    if (receipt.claims_extracted <= 0 && receipt.claims_written <= 0) continue;
    const at = Date.parse(receipt.started_at);
    if (!Number.isFinite(at)) return { kind: "unparseable" };
    if (at >= latest) {
      latest = at;
      startedAt = receipt.started_at;
    }
  }
  return startedAt === null ? { kind: "none" } : { kind: "at", started_at: startedAt };
}

/** True first fill only when every live/superseded asserted_at parses. */
function initialCapture(db: Database, startedAt: string): boolean {
  if (!tableExists(db, "claims")) return false;
  const row = db
    .query<{ invalid: number; prior: number; current: number }, [string, string]>(
      `SELECT
         EXISTS (
           SELECT 1 FROM claims
            WHERE status IN ('live', 'superseded')
              AND julianday(asserted_at) IS NULL
         ) AS invalid,
         EXISTS (
           SELECT 1 FROM claims
            WHERE status IN ('live', 'superseded')
              AND julianday(asserted_at) < julianday(?)
         ) AS prior,
         EXISTS (
           SELECT 1 FROM claims
            WHERE status IN ('live', 'superseded')
              AND julianday(asserted_at) >= julianday(?)
         ) AS current`,
    )
    .get(startedAt, startedAt);
  if (Number(row?.invalid ?? 0) !== 0) return false;
  return Number(row?.prior ?? 0) === 0 && Number(row?.current ?? 0) !== 0;
}

function calibration(db: Database, receipts: RunReceipt[], now: string): CalibrationDoctor {
  const failures: string[] = [];
  if (receipts.length === 0) {
    return {
      window_days: RUN_RECEIPT_RETENTION_DAYS,
      write_rate: null,
      dedup_rate: null,
      confidence_spread: null,
      canon_writes_today: 0,
      top_subjects: [],
      bands_enforced: false,
      bands_reason: "no-receipts",
      failures,
    };
  }
  const extracted = receipts.reduce((sum, receipt) => sum + receipt.claims_extracted, 0);
  const written = receipts.reduce((sum, receipt) => sum + (receipt.claims_written_extracted ?? receipt.claims_written), 0);
  const deduped = receipts.reduce((sum, receipt) => sum + receipt.claims_deduped, 0);
  const writeRate = written / Math.max(1, extracted);
  const dedupRate = deduped / Math.max(1, extracted);
  const clock = latestExtractingStartedAt(receipts);
  // An unreadable receipt clock cannot tell a first fill from drift. Say so
  // rather than quietly judging the vault as if it were in steady state.
  if (clock.kind === "unparseable") failures.push("calibration_clock_unreadable");
  // The band is a steady-state control in both directions: on a true initial
  // capture the corpus that dedup and supersession need does not exist yet.
  const bandsReason: CalibrationBandsReason | null =
    clock.kind === "unparseable"
      ? "receipt-clock-unparseable"
      : extracted < MIN_CALIBRATION_SAMPLE
        ? "insufficient-sample"
        : clock.kind === "at" && initialCapture(db, clock.started_at)
          ? "initial-capture"
          : null;
  if (
    bandsReason === null &&
    (writeRate < CALIBRATION_BAND.min || writeRate > CALIBRATION_BAND.max)
  ) {
    failures.push(`write_rate ${writeRate.toFixed(3)} outside [${CALIBRATION_BAND.min}, ${CALIBRATION_BAND.max}]`);
  }
  const rows = tableExists(db, "claims")
    ? db
        .query<
          {
            confidence: number;
            provenance: string;
            corroboration: number;
            authority: string;
          },
          []
        >(
          `SELECT confidence, provenance, corroboration, authority FROM claims
            WHERE status IN ('live', 'superseded')
            ORDER BY asserted_at DESC
            LIMIT 10000`,
        )
        .all()
    : [];
  // SINGLE_SOURCE_CAP flattens single-source confidence; that is policy, not a missing producer.
  const measurable = rows.filter((row) => !policyCapped(row)).map((row) => row.confidence);
  // Report the same population we assess. Null means no informative confidence,
  // rather than a zero spread that incorrectly suggests a flat model output.
  const spread = stdev(measurable);
  if (measurable.length >= MIN_CALIBRATION_SAMPLE && spread !== null && spread < CONFIDENCE_SPREAD_MIN) {
    failures.push("confidence_not_produced");
  }
  const today = now.slice(0, 10);
  const canonToday = receipts
    .filter((receipt) => receipt.finished_at.startsWith(today))
    .reduce((sum, receipt) => sum + receipt.canon_writes, 0);
  const subjects = tableExists(db, "claims")
    ? db
        .query<{ subject: string; writes: number }, []>(
          `SELECT subject, COUNT(*) AS writes FROM claims
            WHERE asserted_at >= datetime('now', '-7 days')
            GROUP BY subject
            ORDER BY writes DESC, subject
            LIMIT 8`,
        )
        .all()
    : [];
  return {
    window_days: RUN_RECEIPT_RETENTION_DAYS,
    write_rate: writeRate,
    dedup_rate: dedupRate,
    confidence_spread: spread,
    canon_writes_today: canonToday,
    top_subjects: subjects,
    bands_enforced: bandsReason === null,
    bands_reason: bandsReason,
    failures,
  };
}

/**
 * A pass is judged by its final request: a rejection a later request answered
 * past stays counted in the receipt, but it is not a current failure. Whole-call
 * rejection is distinct from a counted, permitted draft drop.
 */
function modelFailure(receipt: RunReceipt): string | null {
  if (receipt.model.last_request === "answered") return null;
  if (receipt.model.diagnostic !== undefined) return formatProducerDiagnostic(receipt.model.diagnostic);
  if (receipt.model.usage_unknown === true) return "model attempt interrupted; token usage unknown";
  if (receipt.model.unavailable > 0) return "model unavailable";
  for (const reason of ["tool_call_in_response", "fence_leak", "schema_invalid", "provenance_not_cited", "budget_exhausted"]) {
    if ((receipt.claims_rejected[reason] ?? 0) > 0 || receipt.errors.includes(reason)) return `model result rejected: ${reason.replaceAll("_", " ")}`;
  }
  return null;
}

/** The model answered at least one request of the pass, however the pass ended. */
function modelAnswered(receipt: RunReceipt): boolean {
  return receipt.model.answered === undefined
    ? receipt.model.calls > 0 && modelFailure(receipt) === null
    : receipt.model.answered > 0;
}

function modelDoctor(
  history: ModelRunHistory,
  modelRef: string | null | undefined,
  reasoningEffort: string | null | undefined,
  configuredModelRef: string | null | undefined,
  configCanonDay: number,
  usedToday: number,
  configCanonRun: number,
  lastRunUsed: number,
): ModelDoctor {
  const receipts = history.receipts;
  const on = typeof modelRef === "string" && modelRef.length > 0;
  const unverified = !on && typeof configuredModelRef === "string" && configuredModelRef.length > 0;
  const currentRef = on ? modelRef : unverified ? configuredModelRef : null;
  const currentDigest = currentRef === null ? null : sha256Hex(currentRef);
  const displayRef = currentRef === null ? null : redactReceiptText(currentRef);
  const current = currentRef === null ? [] : receipts.filter((receipt): receipt is RunReceipt => receipt !== null && receipt.rail === "sync" && (
    receipt.model.model_ref_sha256 !== undefined ? receipt.model.model_ref_sha256 === currentDigest :
      receipt.model.model_ref !== null && !isRedactedModelReference(receipt.model.model_ref) && receipt.model.model_ref === currentRef
  ));
  const unattributed = currentRef === null ? [] : receipts.filter((receipt): receipt is RunReceipt => receipt !== null && receipt.rail === "sync" &&
    receipt.model.model_ref_sha256 === undefined && receipt.model.model_ref !== null && isRedactedModelReference(receipt.model.model_ref) &&
    receipt.model.model_ref === displayRef && (receipt.model.calls > 0 || modelFailure(receipt) !== null));
  const latestFirst = [...current].reverse();
  const lastOk = latestFirst.find(modelAnswered);
  const lastFailed = latestFirst.find(receipt => modelFailure(receipt) !== null);
  const lastFailure = lastFailed === undefined ? null : { at: lastFailed.finished_at, detail: modelFailure(lastFailed)! };
  const lastAttempt = latestFirst.find(receipt => receipt.model.calls > 0 || modelFailure(receipt) !== null);
  const currentFailure = lastAttempt !== undefined && modelFailure(lastAttempt) !== null ? lastFailure : null;
  const lastUnattributed = unattributed.at(-1);
  // Use the durable receipt order, including its run-id tie break. An older
  // known success cannot resolve a newer potentially matching unknown attempt.
  const lastAttemptIndex = lastAttempt === undefined ? -1 : receipts.lastIndexOf(lastAttempt);
  const historyUnverified = (lastUnattributed !== undefined && receipts.lastIndexOf(lastUnattributed) > lastAttemptIndex) ||
    receipts.lastIndexOf(null) > lastAttemptIndex || (history.truncated && lastAttempt === undefined);
  const unavailable = current.reduce((sum, receipt) => sum + receipt.model.unavailable, 0);
  const effort = on ? reasoningEffort ?? null : null;
  // A pass that made no request neither extends nor ends the run of failures.
  let consecutiveFailures = 0;
  for (const receipt of latestFirst) {
    if (modelFailure(receipt) !== null) consecutiveFailures += 1;
    else if (receipt.model.calls > 0) break;
  }
  // This process cannot bind the model, so the daemon's own receipts are the
  // evidence; "unverified" is only for a configured model no daemon ever ran.
  const daemonSeen = unverified && current.length > 0;
  const daemonView = `daemon last_success=${lastOk?.finished_at ?? "never"}${lastFailure === null ? "" : ` last_failure=${lastFailure.detail} at ${lastFailure.at}`} consecutive_failures=${consecutiveFailures}`;
  return {
    canon_writing: on ? "on" : daemonSeen ? "configured" : unverified ? "unverified" : "off",
    model_ref: on ? displayRef : null,
    reasoning_effort: effort,
    last_success_at: lastOk?.finished_at ?? null,
    last_failure: lastFailure,
    current_failure: currentFailure,
    unattributed_receipts: unattributed.length,
    history_unverified: historyUnverified,
    history_truncated: history.truncated,
    unavailable,
    consecutive_failures: consecutiveFailures,
    budget: {
      canon_writes_per_run: { used: lastRunUsed, limit: configCanonRun },
      canon_writes_per_day: { used: usedToday, limit: configCanonDay },
    },
    detail: (on
      ? `canon writing: on (${displayRef}, reasoning_effort=${effort ?? "provider-default"}); last_success=${lastOk?.finished_at ?? "never"} unavailable=${unavailable}${lastFailure === null ? "" : `; last_failure=${lastFailure.detail} (at ${lastFailure.at})`}`
      : daemonSeen
        ? `canon writing: configured; ${daemonView}`
      : unverified
        ? "canon writing: unverified (model configured but not bound by the running host)"
      : "canon writing: off (no model configured — connectors, ledger, search, timeline and undo still work)") +
      (unattributed.length === 0 ? "" : `; model history: unattributed receipts=${unattributed.length}`) +
      (history.truncated ? "; selected history window truncated; last_success, last_failure and counts cover only selected receipts" : "") +
      (historyUnverified ? "; current history unverified" : ""),
  };
}

function countWriterRoles(db: Database): StoreDoctor["writers"] {
  const writers = {
    loop: 0,
    correction: 0,
    import: 0,
    revert: 0,
  };
  if (!tableExists(db, "canon_receipts")) return writers;
  const rows = db
    .query<{ writer: string; n: number }, []>(
      "SELECT writer, COUNT(*) AS n FROM canon_receipts GROUP BY writer",
    )
    .all();
  for (const row of rows) {
    switch (row.writer) {
      case "loop":
      case "correction":
      case "import":
      case "revert":
        writers[row.writer] = row.n;
        break;
      default:
        break;
    }
  }
  return writers;
}

const HASH_HEX = /^[a-f0-9]{64}$/;
const MAX_PAGE_RECEIPTS = 4096;
const EVENT_COLUMNS = `
  event_id, connector_id, source_record_id, kind, occurred_at, observed_at,
  text, subjects, sensitivity_hint, deleted, attachments, metadata,
  content_hash, accepted_at, content_hash_version, text_hash, origin,
  origin_binding_version, origin_binding_kind, origin_binding
`;

interface FastReceiptRow {
  receipt_id: string;
  page_path: string;
  receipt_kind: string;
  before_hash: string | null;
  after_hash: string;
  authority: string;
  reverts: string | null;
  archive_path: string | null;
  at: string;
}

function parseBoundedEventJson(raw: string): unknown {
  if (
    typeof raw !== "string" ||
    raw.length > EVENT_LIMITS.eventBytes ||
    utf8ByteLength(raw) > EVENT_LIMITS.eventBytes
  ) {
    throw new Error("event_record_invalid");
  }
  return JSON.parse(raw);
}

/**
 * Cryptographically verifies a stored event row using a pre-checked native
 * digest, avoiding per-row SQLite lookups (`nativeRequestDigest` and
 * `validatedRowsOf`) and the 64 MB connection-scoped validation cache.
 */
function verifyExternalEventRow(
  row: EventRow,
  db: Database,
  nativeEventIds: ReadonlySet<string>,
): boolean {
  if (
    (row.deleted !== 0 && row.deleted !== 1) ||
    !isRfc3339(row.accepted_at) ||
    row.accepted_at.length > EVENT_LIMITS.timestampBytes
  ) {
    return false;
  }
  const raw = {
    schema: EVENT_SCHEMA,
    event_id: row.event_id,
    connector_id: row.connector_id,
    source_record_id: row.source_record_id,
    kind: row.kind,
    occurred_at: row.occurred_at,
    observed_at: row.observed_at,
    text: row.text,
    subjects: parseBoundedEventJson(row.subjects),
    ...(row.sensitivity_hint === null ? {} : { sensitivity_hint: row.sensitivity_hint }),
    deleted: row.deleted === 1,
    attachments: parseBoundedEventJson(row.attachments),
    metadata: parseBoundedEventJson(row.metadata),
    content_hash: row.content_hash,
    content_hash_version: row.content_hash_version,
    text_hash: row.text_hash,
    origin: row.origin,
    origin_binding_version: row.origin_binding_version,
    origin_binding_kind: row.origin_binding_kind,
    origin_binding: row.origin_binding,
  };
  const digest = nativeEventIds.has(row.event_id)
    ? nativeRequestDigest(db, row.event_id)
    : null;
  return (
    validateEventRecord(raw, {
      accepted_at: row.accepted_at,
      native_request_digest: digest,
    }).origin === "external"
  );
}

/**
 * Batched equivalent of `assessWalkEvidence` for `storeDoctor`. Ordinary v1
 * write receipts are resolved in bulk inside a single deferred read transaction;
 * typed v2 receipts, reverts, purge rewrites, lineage checkpoints, and any edge
 * cases delegate to `CanonAuthorityResolver` + `assessLivePageEvidence`.
 */
function assessWalkEvidenceForDoctor(
  db: Database,
  candidates: readonly CanonPage[],
): WalkEvidence {
  const assessed = new Map<string, PageAssessment>();
  if (candidates.length === 0) return assessed;

  return db.transaction(() => {
    const recoveryPending = new Set<string>();
    if (tableExists(db, "canon_write_intents")) {
      for (const row of db.query<{ page_path: string }, []>(
        "SELECT page_path FROM canon_write_intents",
      ).all()) {
        recoveryPending.add(row.page_path);
      }
    }
    if (tableExists(db, "canon_projection_obligations")) {
      for (const row of db.query<{ page_path: string }, []>(
        "SELECT page_path FROM canon_projection_obligations",
      ).all()) {
        recoveryPending.add(row.page_path);
      }
    }

    const candidatePaths = new Set<string>();
    for (const page of candidates) candidatePaths.add(page.relPath);

    let fallbackAll = false;
    const typedOrErasedPaths = new Set<string>();
    const lineageReceiptIds = new Set<string>();
    const overflowPaths = new Set<string>();
    const receiptsByPath = new Map<string, FastReceiptRow[]>();

    if (tableExists(db, "canon_receipts")) {
      const cols = new Set(
        db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('canon_receipts')")
          .all()
          .map((row) => row.name),
      );
      if (cols.has("record_codec") || cols.has("receipt_state")) {
        const whereParts: string[] = [];
        if (cols.has("receipt_state")) whereParts.push("receipt_state = 'erased'");
        if (cols.has("record_codec")) whereParts.push("(record_codec IS NOT NULL AND record_codec <> 'v1')");
        for (const row of db.query<{ page_path: string }, []>(
          `SELECT DISTINCT page_path FROM canon_receipts
            WHERE (${whereParts.join(" OR ")}) AND page_path IS NOT NULL`,
        ).all()) {
          typedOrErasedPaths.add(row.page_path);
        }
      }

      if (tableExists(db, "canon_source_survivor_lineage")) {
        try {
          for (const row of db.query<{ child_receipt_id: string }, []>(
            "SELECT child_receipt_id FROM canon_source_survivor_lineage",
          ).all()) {
            lineageReceiptIds.add(row.child_receipt_id);
          }
        } catch {
          fallbackAll = true;
        }
      }

      if (!fallbackAll) {
        const countByPath = new Map<string, number>();
        const collectRow = (row: FastReceiptRow): void => {
          if (!candidatePaths.has(row.page_path)) return;
          const nextCount = (countByPath.get(row.page_path) ?? 0) + 1;
          countByPath.set(row.page_path, nextCount);
          if (nextCount > MAX_PAGE_RECEIPTS) {
            overflowPaths.add(row.page_path);
            return;
          }
          let list = receiptsByPath.get(row.page_path);
          if (list === undefined) {
            list = [];
            receiptsByPath.set(row.page_path, list);
          }
          list.push(row);
        };

        const receiptCols = "receipt_id, page_path, receipt_kind, before_hash, after_hash, authority, reverts, archive_path, at";
        if (candidatePaths.size > 400) {
          for (const row of db.query<FastReceiptRow, []>(
            `SELECT ${receiptCols} FROM canon_receipts WHERE page_path IS NOT NULL`,
          ).iterate()) {
            collectRow(row);
          }
        } else {
          const paths = [...candidatePaths];
          const slots = paths.map(() => "?").join(",");
          for (const row of db.query<FastReceiptRow, string[]>(
            `SELECT ${receiptCols} FROM canon_receipts WHERE page_path IN (${slots})`,
          ).all(...paths)) {
            collectRow(row);
          }
        }

        for (const rows of receiptsByPath.values()) {
          if (rows.length > 1) {
            rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.receipt_id.localeCompare(a.receipt_id));
          }
        }
      }
    }

    const fastEntries: {
      page: CanonPage;
      sourceIds: string[];
      revision: CanonRevisionBasis | null;
    }[] = [];
    const fallbackPages: CanonPage[] = [];
    const neededEventIds = new Set<string>();

    for (const page of candidates) {
      if (recoveryPending.has(page.relPath)) {
        assessed.set(page.relPath, {
          evidence: { admitted: false, reason: "recovery_pending" },
          derivable: false,
        });
        continue;
      }
      const sources = parsePageSources(page.data);
      if (!sources.ok || sources.value.length === 0) {
        assessed.set(page.relPath, {
          evidence: { admitted: false, reason: "sources_unavailable" },
          derivable: false,
        });
        continue;
      }
      const sourceIds = [...new Set(sources.value.map(eventIdFromReference))];
      if (
        fallbackAll ||
        typedOrErasedPaths.has(page.relPath) ||
        overflowPaths.has(page.relPath) ||
        !HASH_HEX.test(page.contentHash)
      ) {
        fallbackPages.push(page);
        continue;
      }

      const match = receiptsByPath
        .get(page.relPath)
        ?.find((row) => row.after_hash === page.contentHash);
      let revision: CanonRevisionBasis | null = null;
      if (match !== undefined) {
        if (
          match.receipt_kind !== "write" ||
          match.reverts !== null ||
          lineageReceiptIds.has(match.receipt_id) ||
          !Number.isFinite(Date.parse(match.at)) ||
          !isAuthorityTier(match.authority) ||
          (match.before_hash !== null && !HASH_HEX.test(match.before_hash))
        ) {
          fallbackPages.push(page);
          continue;
        }
        try {
          assertReceiptPaths({ page_path: match.page_path, archive_path: match.archive_path });
        } catch {
          fallbackPages.push(page);
          continue;
        }
        revision = {
          receipt_id: match.receipt_id,
          after_hash: match.after_hash,
          at: match.at,
          authority: match.authority as AuthorityTier,
        };
      }
      fastEntries.push({ page, sourceIds, revision });
      for (const id of sourceIds) neededEventIds.add(id);
    }

    const liveExternalEvents = new Set<string>();
    if (neededEventIds.size > 0 && tableExists(db, "events")) {
      try {
        const hasNativeTable = tableExists(db, "native_owner_evidence");
        const nativeEventIds = new Set<string>();
        if (hasNativeTable) {
          for (const row of db
            .query<{ event_id: string }, []>("SELECT event_id FROM native_owner_evidence")
            .all()) {
            nativeEventIds.add(row.event_id);
          }
        }
        const hasTombstones =
          db.query("SELECT 1 FROM events WHERE deleted = 1 LIMIT 1").get() !== null;
        const liveClause = hasTombstones ? LIVE_PREDICATE : "events.deleted = 0";
        const ids = [...neededEventIds];
        for (let offset = 0; offset < ids.length; offset += 500) {
          const batch = ids.slice(offset, offset + 500);
          const slots = batch.map(() => "?").join(",");
          const rows = db
            .query<EventRow, string[]>(
              `SELECT ${EVENT_COLUMNS} FROM events
                WHERE event_id IN (${slots}) AND origin = 'external' AND ${liveClause}`,
            )
            .all(...batch);
          for (const row of rows) {
            try {
              const valid = hasNativeTable
                ? verifyExternalEventRow(row, db, nativeEventIds)
                : eventFromRow(row, db).origin === "external";
              if (valid) liveExternalEvents.add(row.event_id);
            } catch {
              // Corrupt event rows remain unadmitted, matching assessLivePageEvidence.
            }
          }
        }
      } catch {
        // Unreadable events table leaves liveExternalEvents empty (sources_unavailable).
      }
    }

    const policyEpoch = sourcePolicyEpoch(db);
    const grants = new Map<string, SourceGrant | null>();
    const grantOf = (sourceKey: string): SourceGrant | null => {
      if (grants.has(sourceKey)) return grants.get(sourceKey)!;
      const loaded = inspectSourceGrant(db, sourceKey);
      grants.set(sourceKey, loaded);
      return loaded;
    };
    const allowedEvents = new Map<string, boolean>();
    const eventDerivable = (id: string): boolean => {
      const cached = allowedEvents.get(id);
      if (cached !== undefined) return cached;
      const ok = sourceEventsAllowed(db, [id], { owner: true, purpose: "derive", grantOf });
      allowedEvents.set(id, ok);
      return ok;
    };

    for (const entry of fastEntries) {
      if (entry.sourceIds.some((id) => !liveExternalEvents.has(id))) {
        assessed.set(entry.page.relPath, {
          evidence: { admitted: false, reason: "sources_unavailable" },
          derivable: false,
        });
        continue;
      }
      if (entry.revision === null) {
        assessed.set(entry.page.relPath, {
          evidence: { admitted: false, reason: "revision_unrecorded" },
          derivable: false,
        });
        continue;
      }
      const derivable =
        policyEpoch === 0 ? true : entry.sourceIds.every(eventDerivable);
      assessed.set(entry.page.relPath, {
        evidence: {
          admitted: true,
          sourceIds: entry.sourceIds,
          revision: entry.revision,
        },
        derivable,
      });
    }

    if (fallbackPages.length > 0) {
      const resolver = new CanonAuthorityResolver(
        db,
        fallbackPages.map((page) => page.relPath),
      );
      for (const page of fallbackPages) {
        const evidence = assessLivePageEvidence(db, page, resolver);
        const derivable =
          evidence.admitted &&
          (policyEpoch === 0
            ? true
            : sourceEventsAllowed(db, evidence.sourceIds, {
                owner: true,
                purpose: "derive",
                grantOf,
              }));
        assessed.set(page.relPath, { evidence, derivable });
      }
    }

    return assessed;
  }).deferred();
}

function countOriginPages(report: CanonPageReport): StoreDoctor["origin"] {
  let machine = 0;
  let human = 0;
  for (const page of report.pages) {
    if (isMachineOriginPath(page.relPath)) machine += 1;
    else human += 1;
  }
  for (const page of report.skipped) {
    if (isMachineOriginPath(page.relPath)) machine += 1;
    else human += 1;
  }
  return { machine, human };
}

function vectorLayer(embedding: EmbeddingSelection, vaultPath: string): StoreDoctor["vector_layer"] {
  switch (embedding.state) {
    case "off": return { state: "off", detail: "vector layer: off (no embedding model configured)" };
    case "invalid": return { state: "invalid", detail: `vector layer: invalid (${embedding.message})` };
    case "configured": {
      let retrieval: string;
      try { retrieval = loadConfiguredRetrieval(vaultPath).id; }
      catch { return { state: "configured", detail: `vector layer: configured (${embedding.id})` }; }
      if (retrieval !== "kizuki.retrieval.embedded-pg") {
        return { state: "unbound", detail: `vector layer: not in use (${embedding.id} is configured, but retrieval is ${retrieval}; select kizuki.retrieval.embedded-pg to rank by vector)` };
      }
      const refusal = readRetrievalEngineRefusal(vaultPath, retrieval);
      if (refusal !== null) {
        return {
          state: "refused",
          detail: `vector layer: refused (last index update exceeded ${refusal.resource ?? "text_bytes"}: ${refusal.requested ?? refusal.corpus_bytes} > ${refusal.limit ?? refusal.limit_bytes}; the prior index is preserved, and the lexical floor remains available. Use a smaller corpus; raise max_text_bytes only with sufficient memory)`,
        };
      }
      return { state: "configured", detail: `vector layer: configured (${embedding.id})` };
    }
  }
}

function storeDoctor(
  db: Database,
  vaultPath: string,
  now: string,
  embeddingReceipts: RunReceipt[],
  pages: CanonPageReport,
  embedding: EmbeddingSelection,
): StoreDoctor {
  const pendingRetrieval = countPendingRetrievalOps(db);
  const oldestRetrieval =
    tableExists(db, "retrieval_ops") && pendingRetrieval > 0
      ? db
          .query<{ created_at: string }, []>(
            `SELECT created_at FROM retrieval_ops
              WHERE state = 'pending' ORDER BY created_at LIMIT 1`,
          )
          .get()?.created_at ?? null
      : null;
  const purge = inspectPurgeHealth(db, now);
  const pendingPurge = tableExists(db, "purge_ops")
    ? db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM purge_ops WHERE state = 'pending'",
        )
        .get()?.n ?? 0
    : 0;
  const oldestPurge = tableExists(db, "purge_ops")
    ? db
        .query<{ created_at: string }, []>(
          `SELECT created_at FROM purge_ops
            WHERE state = 'pending' ORDER BY created_at LIMIT 1`,
        )
        .get()?.created_at ?? null
    : null;
  const oldestRetrievalAge = ageSeconds(oldestRetrieval, now);
  const degraded: string[] = [];
  if (oldestRetrievalAge !== null && oldestRetrievalAge > RETRIEVAL_SLA_SECONDS) {
    degraded.push("retrieval-ops-stale");
  }
  if (!purge.ok) degraded.push("purge-unhealthy");
  // Skipped and held documents are what make an index degraded; a stamp that
  // says so after the last of them was fixed is stale, and both are empty.
  const heldPaths = readDerivedHolds(db).paths;
  const held = heldPaths.size;
  const candidates = pages.pages.filter(
    (page) => isLiveCanonPage(page) && !isDeterministicBrief(page) && !heldPaths.has(page.relPath),
  );
  const skippedPages = derivedPageSkips(
    db,
    pages,
    assessWalkEvidenceForDoctor(db, candidates),
  );
  if (skippedPages.length > 0 || held > 0) degraded.push("index-degraded");
  if (pages.truncated) degraded.push("canon-walk-truncated");
  const search = readDerivedMeta(db, "search");
  const graph = readDerivedMeta(db, "graph");
  return {
    pending_retrieval_ops: pendingRetrieval,
    oldest_retrieval_op_age_s: oldestRetrievalAge,
    pending_purge_ops: pendingPurge,
    oldest_purge_op_age_s: ageSeconds(oldestPurge, now),
    embedding_throughput_docs_per_s: embeddingThroughputFromReceipts(embeddingReceipts),
    vector_layer: vectorLayer(embedding, vaultPath),
    orphan_run_receipts: orphanJournalReceipts(db, vaultPath),
    derived: {
      search: {
        rebuilt_at: search?.rebuilt_at ?? null,
        doc_count: search?.doc_count ?? 0,
        status: search?.status ?? null,
        skipped_count: search?.skipped_count ?? 0,
        ledger_watermark: search?.ledger_watermark ?? null,
      },
      graph: {
        rebuilt_at: graph?.rebuilt_at ?? null,
        doc_count: graph?.doc_count ?? 0,
        status: graph?.status ?? null,
        skipped_count: graph?.skipped_count ?? 0,
        ledger_watermark: graph?.ledger_watermark ?? null,
      },
    },
    skipped_pages: skippedPages.slice(0, DOCTOR_SKIPPED_PAGES),
    skipped_pages_total: skippedPages.length,
    held_pages: held,
    pages_truncated: pages.truncated,
    writers: countWriterRoles(db),
    origin: countOriginPages(pages),
    degraded,
  };
}

function expectRailLiveness(intent: ServeIntent | "unknown", supervisor: SupervisorStatus): boolean {
  return intent === "installed" && supervisor.state === "active";
}

export function inspectServeDoctor(
  db: Database,
  vaultPath: string,
  options: ServeDoctorOptions = {},
): ServeDoctorReport {
  const now = options.now ?? new Date().toISOString();
  let intent: ServeIntent | "unknown";
  try { intent = readServeIntent(vaultPath); }
  catch { intent = "unknown"; }
  const supervisor = options.supervisor
    ? queryServeService(vaultPath, options.supervisor)
    : {
        kind: "none" as const,
        state: "none" as const,
        unit: null,
        enabled: false,
        detail: "supervisor: none (loop runs only while you run it)",
      };
  const since = new Date(Date.parse(now) - RUN_RECEIPT_RETENTION_DAYS * 86_400_000).toISOString();
  const hostChecks = options.host_checks !== false;
  const expectLive = hostChecks && expectRailLiveness(intent, supervisor);
  const schedules = new Map(listSchedules(db).map((row) => [row.rail, row]));
  const config = loadServeConfig(vaultPath);
  const embedding = loadEmbeddingSelection(vaultPath);
  const modelRef = options.model_ref ?? null;
  const configuredModelRef = options.configured_model_ref ?? loadConfiguredModelRef(vaultPath);
  const modelConfigured = Boolean(modelRef || configuredModelRef);
  // Bounded reads: the newest sync passes, and the newest runs of every other
  // rail. A week of receipts is mostly no-op maintenance runs that judge nothing.
  const syncHistory = readModelRunHistory(db, since, DOCTOR_SYNC_RECEIPTS);
  const syncReceipts = syncHistory.receipts.filter((receipt): receipt is RunReceipt => receipt !== null);
  // A held writer prevents publication, but its skipped runs are already
  // durable in the journal. Include them in rail health without replaying or
  // changing the ledger, and retain the same bounded chronological window.
  const pendingReceipts = readPendingRunReceipts(db, vaultPath);
  const railHistory = (rail: RailId): RunReceipt[] => {
    const limit = rail === "sync" ? DOCTOR_SYNC_RECEIPTS : DOCTOR_RAIL_RECEIPTS;
    const persisted = rail === "sync" ? syncReceipts : listRunReceipts(db, { rail, ...(rail === "verify-world" ? {} : { since }), limit });
    const runs = new Map(pendingReceipts.filter(receipt => receipt.rail === rail && receipt.finished_at >= since)
      .map(receipt => [receipt.run_id, receipt]));
    for (const receipt of persisted) runs.set(receipt.run_id, receipt);
    return [...runs.values()]
      .sort((a, b) => a.finished_at.localeCompare(b.finished_at) || a.run_id.localeCompare(b.run_id))
      .slice(-limit);
  };
  const work = { db, model_configured: modelConfigured, embedding_configured: options.embedding_configured ?? embedding.state === "configured" };
  const rails = listRails().map((rail) => railDoctor(
    rail.id,
    railHistory(rail.id),
    schedules.get(rail.id)?.period_s ?? rail.period_s,
    now,
    expectLive,
    syncPassWait(config.extraction),
    work,
    schedules.get(rail.id)?.last_run_at ?? null,
  ));
  const usedToday = syncReceipts
    .filter((receipt) => receipt.finished_at.startsWith(now.slice(0, 10)))
    .reduce((sum, receipt) => sum + receipt.canon_writes, 0);
  const lastSync = syncReceipts.at(-1);
  const lastRunUsed = lastSync?.budget.canon_writes_per_run?.used ?? lastSync?.canon_writes ?? 0;
  const model = modelDoctor(
    modelConfigured ? syncHistory : { receipts: [], truncated: false },
    modelRef,
    options.reasoning_effort,
    configuredModelRef,
    config.canon_writes_per_day,
    usedToday,
    config.canon_writes_per_run,
    lastRunUsed,
  );
  const skipped = syncReceipts.reduce((sum, receipt) => sum + (receipt.records_skipped ?? 0), 0);
  const throughput = throughputDoctor(config, schedules.get("sync")?.period_s ?? config.sync_period_s, skipped);
  const oversized = oversizedDoctor(db);
  const pages: CanonPageReport =
    options.page_walk === false
      ? { pages: [], skipped: [], truncated: false, signatures: new Map(), scanned_files: 0, scanned_bytes: 0 }
      : options.pages ?? listCanonPagesReport(vaultPath, undefined, undefined, { include_body: false, track_capacity: false });
  const quarantined = quarantineDoctor(db, now);
  const canon = options.page_walk === false ? null : canonCapacity(pages.pages, pages.truncated, loadCanonLimits(vaultPath), pages);
  const stores = storeDoctor(db, vaultPath, now, readEmbeddingReceipts(db, since, DOCTOR_RAIL_RECEIPTS), pages, embedding);
  const cal = calibration(db, syncReceipts, now);
  const extraction = extractionDoctor(db, syncReceipts, model.canon_writing !== "off");
  const { egress, failures: egressFailures } = egressDoctor(db, options.judge ?? null);
  const found: { text: string; top: TopFailure }[] = [];
  const fail = (text: string, kind: TopFailure["kind"] = "other", rail: RailId | null = null): void => {
    found.push({ text, top: { kind, rail } });
  };
  if (model.current_failure !== null) fail(`${model.current_failure.detail} (at ${model.current_failure.at})`, "model");
  if (model.history_unverified) fail("model history unverified; the latest current-model attempt cannot be established from retained receipts");
  if (hostChecks && intent === "unknown") fail("service intent unavailable or invalid", "service");
  else if (hostChecks && intent !== "installed" && (supervisor.enabled || supervisor.state === "active")) {
    fail("supervisor active or enabled without installed intent", "service");
  }
  if (hostChecks) {
    try {
      if (serviceFile(join(vaultPath, ".kizuki", "service-change.json")) !== null) fail("service change recovery pending", "service");
    } catch { fail("service recovery state unavailable", "service"); }
  }
  let supervisorExit: SupervisorLastExit | null = null;
  if (hostChecks && intent === "installed" && (supervisor.state !== "active" || !supervisor.enabled)) {
    fail(`supervisor ${supervisor.state}${supervisor.state === "active" ? " but not enabled" : ""}`, "service");
    // The unit's own last exit decides the command that restarts it. A status
    // with no unit is a service bound to another vault, whose exit is not ours.
    if (supervisor.state !== "active" && supervisor.unit !== null && options.supervisor?.lastExit !== undefined) {
      try { supervisorExit = options.supervisor.lastExit(ensureVaultId(vaultPath)); } catch { supervisorExit = null; }
    }
  }
  if (canon !== null && canon.state !== "ok") {
    fail(`canon ${canon.state}: ${canon.live} live pages of ${canon.ceiling}, ${canon.archived} archived; ${canon.state === "scan_limited" ? (pages.truncated ? "counts are incomplete; scan resource budget reached" : "scan resource budget reached; new pages are held, reads continue") : canon.state === "full" ? "new pages are held, reads continue" : "approaching the ceiling"}; next: ${canon.next}`);
  }
  for (const rail of rails) {
    if (rail.status === "down" && rail.reason !== null) {
      fail(`rail ${rail.rail}: ${rail.reason}`, "rail", rail.rail);
    }
  }
  for (const text of [...cal.failures, ...egressFailures]) fail(text);
  if (stores.orphan_run_receipts.length > 0) {
    fail(`orphan run receipts ${stores.orphan_run_receipts.length}`);
  }
  try {
    const recovery = inspectConnectionStateRecovery(join(vaultPath, ".kizuki"));
    if (recovery.unresolved.length > 0) {
      fail(`connection state journals unresolved ${recovery.unresolved.length}`);
    }
    if (recovery.quarantined.length > 0) {
      fail(`connection state journals quarantined ${recovery.quarantined.length}`);
    }
  } catch {
    fail("connection state recovery inspection unavailable");
  }
  for (const item of inspectConnections(db, { includeDisconnected: true })) {
    if (!item.ok) {
      fail(`connection ${item.connector_id} unreadable`);
    }
  }
  for (const item of inspectCheckpoints(db)) {
    if (!item.ok) {
      fail(`checkpoint ${item.connector_id} unreadable`);
    }
  }
  if (stores.degraded.includes("retrieval-ops-stale")) {
    fail("retrieval_ops older than SLA");
  }
  for (const text of inspectPageIndex(db)) fail(text);
  const staleIntent = staleCanonIntentFailure(db, now);
  if (staleIntent !== null) fail(staleIntent);
  const failures = found.map((item) => item.text);

  return {
    supervisor,
    supervisor_exit: supervisorExit,
    intent,
    rails,
    model,
    extraction,
    attention: attentionDoctor(db, vaultPath, now),
    consolidation: consolidationDoctor(db, now, model.canon_writing !== "off", config.consolidation),
    egress,
    throughput,
    oversized,
    quarantined,
    stores,
    canon,
    calibration: cal,
    ok: failures.length === 0,
    failures,
    top_failure: found[0]?.top ?? null,
  };
}

/** A skip is the loop's own receipted decision, not a failure; the retry command re-queues skipped records. */
function oversizedDoctor(db: Database): OversizedDoctor {
  const { segmenting, skipped } = countOversizedRecords(db);
  const retry = skipped === 0 ? null : RETRY_SKIPPED_COMMAND;
  return { segmenting, skipped, retry,
    detail: `oversized records segmenting=${segmenting} skipped=${skipped}${retry === null ? "" : ` retry: ${retry}`}` };
}

/** A set-aside page is the writer's own decision, retried after a day; it is listed, not a failure. */
function quarantineDoctor(db: Database, now: string): QuarantineDoctor {
  const pages = listQuarantinedPages(db, now).map(({ handle, path, attempts, reason, until }) => ({ handle, path, attempts, reason, until }));
  const held = listQuarantinedClaims(db, now);
  const claims = held.claims.map(({ claim_id, attempts, reason, until }) => ({ claim_id, attempts, reason, until }));
  return { pages, ...(claims.length === 0 ? {} : { claims }), ...(held.truncated ? { claims_truncated: true } : {}),
    detail: `quarantined typed pages=${pages.length}${claims.length === 0 && !held.truncated ? "" : ` unmaterialized legacy claims${held.truncated ? " shown" : ""}=${claims.length}${held.truncated ? " (truncated)" : ""}`}` };
}

function throughputDoctor(config: ServeConfig, syncPeriod: number, recordsSkipped: number): ThroughputDoctor {
  const { max_calls_per_pass, records_per_request, max_input_tokens, max_output_tokens, max_pass_seconds, max_calls_per_day, max_output_tokens_per_day } = config.extraction;
  const pending = syncPeriod === config.sync_period_s ? "" : ` configured_sync_period_s=${config.sync_period_s} (applies at service start)`;
  return {
    sync_period_s: syncPeriod,
    configured_sync_period_s: config.sync_period_s,
    max_calls_per_pass,
    records_per_request,
    max_input_tokens,
    max_output_tokens,
    max_pass_seconds,
    max_calls_per_day,
    max_output_tokens_per_day,
    records_skipped: recordsSkipped,
    detail: `throughput sync_period_s=${syncPeriod} max_calls_per_pass=${max_calls_per_pass} records_per_request=${records_per_request} max_input_tokens=${max_input_tokens} max_output_tokens=${max_output_tokens} max_pass_seconds=${max_pass_seconds} max_calls_per_day=${max_calls_per_day} max_output_tokens_per_day=${max_output_tokens_per_day} records_skipped=${recordsSkipped}${pending}`,
  };
}

export function describeSupervisorNone(): string {
  return "supervisor: none (loop runs only while you run it)";
}

export function serveExecHint(vaultPath: string): string {
  return `kizuki serve --vault ${vaultPath}`;
}
