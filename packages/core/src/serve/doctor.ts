import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { embeddingThroughputFromReceipts } from "../retrieval/reembed";
import { inspectPageIndex } from "../canon";
import { isMachineOriginPath } from "../canon/origin";
import { formatProducerDiagnostic } from "../producer/diagnostics";
import { SINGLE_SOURCE_CAP } from "../claims/authority";
import { countPendingRetrievalOps } from "../claims/store";
import { readDerivedMeta } from "../derived-meta";
import { readDerivedHolds } from "../derived-holds";
import { inspectConnectionStateRecovery } from "../ledger/connection-state";
import { inspectCheckpoints, inspectConnections } from "../ledger/connections";
import { tableExists } from "../ledger/schema";
import { inspectPurgeHealth } from "../ledger/purge";
import { listCanonPagesReport, type CanonPageReport } from "../vault/pages";
import { loadConfiguredModelRef, loadEmbeddingSelection, loadServeConfig, type EmbeddingSelection } from "./config";
import { ageSeconds, railDoctor, syncPassWait } from "./doctor-rails";
import { egressDoctor, extractionDoctor } from "./doctor-extraction";
import { readServeIntent } from "./intent";
import { serviceFile } from "./service-files";
import { isRedactedModelReference, listRunReceipts, orphanJournalReceipts, readEmbeddingReceipts, readModelRunHistory, redactReceiptText, type ModelRunHistory } from "./receipts";
import { sha256Hex } from "../util/hash";
import { listSchedules } from "./schema";
import { countOversizedRecords, RETRY_SKIPPED_COMMAND } from "./extract-oversized";
import type { SupervisorHost } from "./supervisor";
import { queryServeService } from "./supervisor";
import { ensureVaultId } from "./vault-id";
import {
  CALIBRATION_BAND,
  CONFIDENCE_SPREAD_MIN,
  DEFAULT_RAILS,
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
  /**
   * False skips the walk of every canon page. The walk parses each page, so a
   * caller inside the daemon's event loop or one that reads a single field
   * turns it off; the skipped-page and origin fields are then empty. Defaults
   * to true.
   */
  readonly page_walk?: boolean;
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

function countOriginPages(report: CanonPageReport): StoreDoctor["origin"] {
  let machine = 0;
  let human = 0;
  for (const relPath of [
    ...report.pages.map((page) => page.relPath),
    ...report.skipped.map((page) => page.relPath),
  ]) {
    if (isMachineOriginPath(relPath)) machine += 1;
    else human += 1;
  }
  return { machine, human };
}

function vectorLayer(embedding: EmbeddingSelection): StoreDoctor["vector_layer"] {
  switch (embedding.state) {
    case "off": return { state: "off", detail: "vector layer: off (no embedding model configured)" };
    case "configured": return { state: "configured", detail: `vector layer: configured (${embedding.id})` };
    case "invalid": return { state: "invalid", detail: `vector layer: invalid (${embedding.message})` };
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
  const held = readDerivedHolds(db).paths.size;
  if (pages.skipped.length > 0 || held > 0) degraded.push("index-degraded");
  if (pages.truncated) degraded.push("canon-walk-truncated");
  const search = readDerivedMeta(db, "search");
  const graph = readDerivedMeta(db, "graph");
  return {
    pending_retrieval_ops: pendingRetrieval,
    oldest_retrieval_op_age_s: oldestRetrievalAge,
    pending_purge_ops: pendingPurge,
    oldest_purge_op_age_s: ageSeconds(oldestPurge, now),
    embedding_throughput_docs_per_s: embeddingThroughputFromReceipts(embeddingReceipts),
    vector_layer: vectorLayer(embedding),
    orphan_run_receipts: orphanJournalReceipts(db, vaultPath),
    derived: {
      search: {
        rebuilt_at: search?.rebuilt_at ?? null,
        doc_count: search?.doc_count ?? 0,
        status: search?.status ?? null,
        skipped_count: search?.skipped_count ?? 0,
      },
      graph: {
        rebuilt_at: graph?.rebuilt_at ?? null,
        doc_count: graph?.doc_count ?? 0,
        status: graph?.status ?? null,
        skipped_count: graph?.skipped_count ?? 0,
      },
    },
    skipped_pages: pages.skipped.slice(0, DOCTOR_SKIPPED_PAGES).map((page) => ({ path: page.relPath, reason: page.code })),
    skipped_pages_total: pages.skipped.length,
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
  const work = { db, model_configured: modelConfigured, embedding_configured: options.embedding_configured ?? embedding.state === "configured" };
  const rails = DEFAULT_RAILS.map((spec) => railDoctor(
    spec.rail,
    spec.rail === "sync" ? syncReceipts : listRunReceipts(db, { rail: spec.rail, since, limit: DOCTOR_RAIL_RECEIPTS }),
    schedules.get(spec.rail)?.period_s ?? spec.period_s,
    now,
    expectLive,
    syncPassWait(config.extraction),
    work,
    schedules.get(spec.rail)?.last_run_at ?? null,
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
      ? { pages: [], skipped: [], truncated: false }
      : listCanonPagesReport(vaultPath);
  const stores = storeDoctor(db, vaultPath, now, readEmbeddingReceipts(db, since, DOCTOR_RAIL_RECEIPTS), pages, embedding);
  const cal = calibration(db, syncReceipts, now);
  const extraction = extractionDoctor(db, syncReceipts, model.canon_writing !== "off");
  const { egress, failures: egressFailures } = egressDoctor(db);
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
  const failures = found.map((item) => item.text);


  return {
    supervisor,
    supervisor_exit: supervisorExit,
    intent,
    rails,
    model,
    extraction,
    egress,
    throughput,
    oversized,
    stores,
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
