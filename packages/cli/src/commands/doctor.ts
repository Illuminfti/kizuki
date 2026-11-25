import type { Database } from "bun:sqlite";
import {
  inspectSourceCoverage,
  inspectWorldKindCoverage,
  type SourceCoverageReport,
  type WorldKindCoverageReport,
} from "@kizuki/core/world";
import { sourceCoverageLines } from "../source-coverage";
import { closeHostConnector } from "../connections";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAIM_STATUSES,
  PURGE_SLA_SECONDS,
  PortError,
  count,
  doctorVault,
  getCheckpoint,
  massWithdrawalHoldOf,
  inspectLedgerHealth,
  inspectCanonRecoveryDetail,
  inspectPurgeHealth,
  inspectServeDoctor,
  latestReceiptForPage,
  listCanonPagesReport,
  readHolds,
  readVaultId,
} from "@kizuki/core";
import type { CanonPageReport, CaptureFanoutCounts, ClaimStatus, LiveClaimProducers, MassWithdrawalHold } from "@kizuki/core";
import { readSqliteRuntime } from "@kizuki/core/internal";
import type { SqliteRuntime } from "@kizuki/core/internal";
import { UsageError, parseArguments } from "../args";
import { listHostConnections, loadConnector } from "../connections";
import { sourceConsentPurged } from "../source-consent";
import { INVOCATION } from "../runtime";
import { withReadVault } from "../context";
import type { ReadVaultContext } from "../context";
import { indexFreshness } from "../derived";
import { RETENTION_MEANING } from "../egress-view";
import { configuredJudgeDestination } from "../judge-destination";
import { clean, errorText, jsonEnvelope } from "../output";
import { embeddingConfigured } from "../retrieval-runtime";
import { effectiveVaultConfig, loadVaultConfig } from "../vault-config";
import { serveTomlModeHint } from "../config-custody";
import { configuredModelBinding, inspectModelBinding, type ModelBindingSummary } from "../serve-runtime";
import { serveSupervisorHost } from "../service-host";
import { withdrawalHoldLine } from "../withdrawal-hold";
import { supervisorFailureLine } from "../service-custody";
import { nextStep } from "./doctor-next";
import { inspectMemtForDoctor, type DoctorMemtReport } from "./memt";
import type { CliIo, Command, CommandHelpSchema } from "./index";

const HEALTH_DEADLINE_MS = 3_000;
const HASH_DRIFT_CAP = 64;
const DETAIL_CAP = 160;

interface DoctorConnection {
  coverage: SourceCoverageReport;
  connector_id: string;
  source_key: string;
  path: string;
  /** `paused`: the owner revoked and purged this source's consent; capture is off by decision. */
  state: "present" | "missing" | "disconnected" | "paused";
  health: string;
  checkpoint: string;
  stored: number;
  errors: number;
  /** Why the last run failed, first reason only; null when it did not. */
  last_error: string | null;
  /** Backfill or a history-covering sync reached its reported end. */
  backfill_complete: boolean;
  /**
   * The last run recorded no error. Not a claim about what is left upstream:
   * the checkpoint keeps no cursor exhaustion, so a clean run says the source
   * answered, not that it has nothing more to give.
   */
  last_run_clean: boolean;
  /**
   * The last run withdrew nothing because it would have withdrawn most of the
   * source. Restoring the source clears it; `sync --confirm-withdrawals`
   * releases it.
   */
  hold: MassWithdrawalHold | null;
  problem: string | null;
}

interface DoctorClaim {
  claim_id: string;
  target: string | null;
  predicate: string | null;
}

interface HashDriftCoverage {
  complete: boolean;
  sampled: boolean;
  truncated: boolean;
  limit: number;
  enumerated: number;
  selected: number;
  checked: number;
  unreceipted: number;
}

interface DoctorReport {
  config: string;
  vault: string;
  vault_id: string | null;
  effective_config: Record<string, unknown>;
  events: number;
  claims: Record<ClaimStatus, number> & {
    filed: number;
    written: number;
    unwritten: number;
    /** Capture notes of conversational events: closed out as skipped, and still live awaiting the doctor-sweep. */
    capture_fanout: CaptureFanoutCounts;
    /** Live claims by producer: model extraction versus deterministic page mirrors. */
    by_producer: LiveClaimProducers;
  };
  live_claims: DoctorClaim[];
  filed_claims: DoctorClaim[];
  connections: DoctorConnection[];
  receipts: number;
  orphans: string[];
  holds: { page_path: string; id: string }[];
  problems: { page: string; error: string }[];
  hash_drift: HashDriftCoverage;
  serve: ReturnType<typeof inspectServeDoctor>;
  /** Why a configured model cannot bind, from the model port's config parser. */
  model_config_error: string | null;
  doctrine: { file: string; state: string }[];
  ledger: ReturnType<typeof inspectLedgerHealth>;
  runtime: SqliteRuntime;
  canon_recovery: ReturnType<typeof inspectCanonRecoveryDetail>;
  world_kinds: WorldKindCoverageReport;
  memt: DoctorMemtReport;
  ok: boolean;
}

export const DOCTOR_SCHEMA = {
  options: [],
  flags: ["--json", "--integrity"],
} as const satisfies CommandHelpSchema;

export const doctorCommand: Command = {
  name: "doctor",
  usage: "doctor [--json] [--integrity]",
  summary: "verify vault identity, receipts, indexes, rails, and connection health",
  schema: DOCTOR_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...DOCTOR_SCHEMA.options],
      flags: [...DOCTOR_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);

    return withReadVault(io, async (ctx) => {
      const report = await collect(
        ctx.configPath,
        ctx.vaultPath,
        ctx,
        io.env,
        parsed.flags.has("--integrity"),
      );
      ctx.assertCurrent();
      if (parsed.flags.has("--json")) {
        io.out(
          jsonEnvelope("doctor", report.ok ? "ok" : "error", report, {
            degraded: [
              ...report.problems.map((problem) => problem.error),
              ...(report.hash_drift.sampled
                ? [hashDriftCoverageLine(report.hash_drift)]
                : []),
            ],
          }),
        );
        return report.ok ? 0 : 1;
      }
      printHuman(io, report);
      return report.ok ? 0 : 1;
    }, { retrieval: "none" });
  },
};

function scrubDetail(text: string | null): string | null {
  if (text === null || text.length === 0) return null;
  const cleaned = clean(text);
  return cleaned.length > DETAIL_CAP ? `${cleaned.slice(0, DETAIL_CAP)}…` : cleaned;
}

async function withDeadline<T>(ms: number, work: () => Promise<T>, label = "health"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = work();
  pending.catch(() => {
    // The process exits when doctor returns; do not leave a late
    // rejection unhandled after the deadline wins the race.
  });
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const CAPTURE_FANOUT_SKIP_REASON = "message_capture_fanout";
const UNWRITTEN_CAPTURE_NOTE_WHERE = `status = 'live' AND receipt_id IS NULL
  AND kind = 'claim' AND producer = 'deterministic'
  AND json_extract(frontmatter, '$.type') = 'source'
  AND json_type(frontmatter, '$."x-source-record-id"') IS NULL
  AND json_extract(frontmatter, '$."x-capture-kind"') IN ('message','email')
  AND target GLOB 'captures/[^/]*' AND target NOT GLOB 'captures/*/*/*'
  AND (target NOT GLOB 'captures/*/*'
       OR target GLOB 'captures/*/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`;

function hasTable(db: Database, name: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== null
  );
}

/** Single-pass aggregate over `claims`, replacing ~12 separate full table scans. */
function readDoctorClaimSummary(db: Database): DoctorReport["claims"] {
  const counts = Object.fromEntries(
    CLAIM_STATUSES.map((status) => [status, 0]),
  ) as Record<ClaimStatus, number>;
  let written = 0;
  let unwritten = 0;
  let fanoutPending = 0;
  let fanoutSkipped = 0;
  const producers = { model: 0, deterministic: 0, owner: 0, agent: 0 };

  if (hasTable(db, "claims")) {
    const typedClause = hasTable(db, "claim_v2_semantics")
      ? "AND NOT EXISTS (SELECT 1 FROM claim_v2_semantics v2 WHERE v2.claim_id = claims.claim_id)"
      : "";
    const rows = db
      .query<
        {
          status: string;
          total: number;
          written: number;
          unwritten: number;
          fanout_pending: number;
          fanout_skipped: number;
          prod_model: number;
          prod_deterministic: number;
          prod_owner: number;
          prod_agent: number;
        },
        [string]
      >(
        `SELECT
           status,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'live' AND receipt_id IS NOT NULL THEN 1 ELSE 0 END) AS written,
           SUM(CASE WHEN status = 'live' AND receipt_id IS NULL AND kind <> 'purge_review'
                     AND NOT COALESCE((${UNWRITTEN_CAPTURE_NOTE_WHERE}), 0) ${typedClause}
                    THEN 1 ELSE 0 END) AS unwritten,
           SUM(CASE WHEN ${UNWRITTEN_CAPTURE_NOTE_WHERE} THEN 1 ELSE 0 END) AS fanout_pending,
           SUM(CASE WHEN status = 'skipped' AND json_extract(frontmatter, '$."x-skip-reason"') = ?
                    THEN 1 ELSE 0 END) AS fanout_skipped,
           SUM(CASE WHEN status = 'live' AND producer = 'model' THEN 1 ELSE 0 END) AS prod_model,
           SUM(CASE WHEN status = 'live' AND producer = 'deterministic' THEN 1 ELSE 0 END) AS prod_deterministic,
           SUM(CASE WHEN status = 'live' AND producer = 'owner' THEN 1 ELSE 0 END) AS prod_owner,
           SUM(CASE WHEN status = 'live' AND substr(producer, 1, 6) = 'agent:' THEN 1 ELSE 0 END) AS prod_agent
         FROM claims
         GROUP BY status`,
      )
      .all(CAPTURE_FANOUT_SKIP_REASON);

    for (const row of rows) {
      if ((CLAIM_STATUSES as readonly string[]).includes(row.status)) {
        counts[row.status as ClaimStatus] = row.total;
      }
      written += row.written ?? 0;
      unwritten += row.unwritten ?? 0;
      fanoutPending += row.fanout_pending ?? 0;
      fanoutSkipped += row.fanout_skipped ?? 0;
      producers.model += row.prod_model ?? 0;
      producers.deterministic += row.prod_deterministic ?? 0;
      producers.owner += row.prod_owner ?? 0;
      producers.agent += row.prod_agent ?? 0;
    }
  }

  return {
    ...counts,
    filed: counts.skipped,
    written,
    unwritten,
    capture_fanout: { pending: fanoutPending, skipped: fanoutSkipped },
    by_producer: producers,
  };
}

function readDoctorSampleClaims(db: Database): {
  live: DoctorClaim[];
  filed: DoctorClaim[];
} {
  if (!hasTable(db, "claims")) return { live: [], filed: [] };
  const live = db
    .query<DoctorClaim, []>(
      `SELECT claim_id, target, predicate FROM claims
        WHERE status = 'live'
        ORDER BY created_at, claim_id
        LIMIT 8`,
    )
    .all();
  const filed = db
    .query<DoctorClaim, [string]>(
      `SELECT claim_id, target, predicate FROM claims
        WHERE status = 'skipped'
          AND json_extract(frontmatter, '$."x-skip-reason"') IS NOT ?
        ORDER BY created_at, claim_id
        LIMIT 8`,
    )
    .all(CAPTURE_FANOUT_SKIP_REASON);
  return { live, filed };
}

function reconcileReceipts(
  vaultPath: string,
  ctx: ReadVaultContext,
): { orphans: string[]; count: number } {
  const orphans: string[] = [];
  const allReceiptIds = new Set<string>();
  const retainedReceiptIds: string[] = [];
  if (hasTable(ctx.db, "canon_receipts")) {
    for (const row of ctx.db
      .query<{ receipt_id: string; page_path: string | null }, []>(
        "SELECT receipt_id, page_path FROM canon_receipts ORDER BY at, receipt_id",
      )
      .iterate()) {
      allReceiptIds.add(row.receipt_id);
      if (row.page_path !== null) retainedReceiptIds.push(row.receipt_id);
    }
  }

  const path = join(vaultPath, ".kizuki", "receipts", "promotions.jsonl");
  const seen = new Set<string>();
  if (existsSync(path)) {
    const content = readFileSync(path, "utf8");
    let lineStart = 0;
    let lineNumber = 0;
    while (lineStart <= content.length) {
      const nl = content.indexOf("\n", lineStart);
      const lineEnd = nl === -1 ? content.length : nl;
      lineNumber += 1;
      if (lineEnd > lineStart) {
        const line = content.slice(lineStart, lineEnd);
        let parsed: unknown;
        let ok = true;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          orphans.push(`torn JSONL line ${lineNumber}`);
          ok = false;
        }
        if (ok) {
          if (typeof parsed !== "object" || parsed === null || !("receipt_id" in parsed)) {
            orphans.push(`invalid JSONL line ${lineNumber}`);
          } else {
            const receiptId = (parsed as { receipt_id: unknown }).receipt_id;
            if (typeof receiptId !== "string" || receiptId.length === 0) {
              orphans.push(`invalid JSONL line ${lineNumber}`);
            } else if (seen.has(receiptId)) {
              orphans.push(`duplicate receipt ${receiptId}`);
            } else {
              seen.add(receiptId);
              // A purge leaves an erased record for each typed receipt it removes; the row still exists.
              if (!allReceiptIds.has(receiptId)) {
                orphans.push(`orphan receipt ${receiptId} (no canon_receipts row)`);
              }
            }
          }
        }
      }
      if (nl === -1) break;
      lineStart = nl + 1;
    }
  }

  for (const receiptId of retainedReceiptIds) {
    if (!seen.has(receiptId)) {
      orphans.push(`orphan row ${receiptId} (no JSONL line)`);
    }
  }
  return { orphans, count: allReceiptIds.size };
}

function hashDriftCoverageLine(coverage: HashDriftCoverage): string {
  return `hash-drift coverage=${coverage.sampled ? "sampled" : "complete"} selected=${coverage.selected} enumerated=${coverage.enumerated} limit=${coverage.limit}`;
}

function hashDrift(
  ctx: ReadVaultContext,
  report: CanonPageReport,
): { problems: { page: string; error: string }[]; coverage: HashDriftCoverage } {
  const selected = report.pages.slice(0, HASH_DRIFT_CAP);
  const problems: { page: string; error: string }[] = [];
  let checked = 0;
  let unreceipted = 0;
  for (const page of selected) {
    const latest = latestReceiptForPage(ctx.db, page.relPath);
    if (latest === null) {
      unreceipted += 1;
      continue;
    }
    checked += 1;
    if (page.contentHash !== latest.after_hash) {
      problems.push({
        page: page.relPath,
        error: `hash drift: file disagrees with receipt ${latest.receipt_id}`,
      });
    }
  }
  const complete = !report.truncated && report.pages.length <= HASH_DRIFT_CAP;
  return {
    problems,
    coverage: {
      complete,
      sampled: !complete,
      truncated: report.truncated,
      limit: HASH_DRIFT_CAP,
      enumerated: report.pages.length,
      selected: selected.length,
      checked,
      unreceipted,
    },
  };
}

async function collect(
  config: string,
  vaultPath: string,
  ctx: ReadVaultContext,
  env: Record<string, string | undefined>,
  fullIntegrity = false,
): Promise<DoctorReport> {
  const claimSummary = readDoctorClaimSummary(ctx.db);

  const connections: DoctorConnection[] = [];
  const coverage = new Map(inspectSourceCoverage(ctx.db).map(report => [report.source_key, report]));
  for (const host of listHostConnections(ctx.db, ctx.store, undefined, { includeDisconnected: true })) {
    const checkpoint = getCheckpoint(
      ctx.db,
      host.connection.connector_id,
      host.connection.source_key,
    );
    const base = {
      coverage: coverage.get(host.connection.source_key)!,
      connector_id: host.connection.connector_id,
      source_key: host.connection.source_key,
      checkpoint: checkpoint?.last_run_at ?? "never",
      stored: checkpoint?.last_result.stored ?? 0,
      errors: checkpoint?.last_result.errors.length ?? 0,
      last_error: scrubDetail(checkpoint?.last_result.errors[0] ?? null),
      backfill_complete: checkpoint?.backfill_complete === true,
      last_run_clean: checkpoint !== null && checkpoint.last_result.errors.length === 0,
      hold: massWithdrawalHoldOf(ctx.db, host.connection.connector_id, host.connection.source_key),
    };
    if (host.connection.disconnected_at !== null) {
      connections.push({ ...base, path: "-", state: "disconnected", health: "disabled", problem: null });
      continue;
    }
    if (sourceConsentPurged(ctx.db, host.connection.source_key)) {
      connections.push({ ...base, path: "-", state: "paused", health: "disabled", problem: `consent purged; capture paused. To resume see: ${INVOCATION} connect status --source ${host.connection.source_key}` });
      continue;
    }
    if (host.state === null) {
      connections.push({
        ...base,
        path: "-",
        state: "missing",
        health: "misconfigured",
        problem: scrubDetail(host.problem),
      });
      continue;
    }
    try {
      const health = await withDeadline(HEALTH_DEADLINE_MS, async () => {
        const connector = await loadConnector(host, ctx.store, ctx.db, env);
        try {
          return await connector.health();
        } finally {
          await closeHostConnector(connector);
        }
      });
      connections.push({
        ...base,
        path: host.state.config.path ?? host.state.config.base_url ?? "managed local state",
        state: "present",
        health: health.state,
        problem: health.state === "ok" ? null : scrubDetail(health.detail ?? null),
      });
    } catch (error) {
      const message = errorText(error);
      connections.push({
        ...base,
        path: host.state.config.path ?? host.state.config.base_url ?? "managed local state",
        state: "present",
        health: message.includes("timed out") ? "timeout" : "misconfigured",
        problem: scrubDetail(message),
      });
    }
  }

  const { orphans, count: receiptCount } = reconcileReceipts(vaultPath, ctx);
  const holds = readHolds(ctx.db).map((hold) => ({
    page_path: hold.page_path,
    id: hold.proposal_id,
  }));

  // Walk canon once without decoding bodies or registering inotify watches;
  // doctorVault, hashDrift, and inspectServeDoctor all consume this snapshot.
  const pageReport = listCanonPagesReport(vaultPath, undefined, undefined, {
    include_body: false,
    track_capacity: false,
  });
  const vault = doctorVault(vaultPath, ctx.db, pageReport);
  const ledger = inspectLedgerHealth(ctx.db, { full: fullIntegrity });
  const problems = vault.pages.flatMap((page) =>
    page.errors.map((error) => ({ page: page.page, error })),
  );
  const canonRecovery = inspectCanonRecoveryDetail(ctx.db, vaultPath);
  if (canonRecovery.pending) {
    problems.push({ page: canonRecovery.page_path ?? "-",
      error: `canon recovery held${canonRecovery.reason === null ? "" : `: ${canonRecovery.reason}`}; next: ${canonRecovery.next}` });
  } else if (canonRecovery.projection_pending > 0) {
    problems.push({ page: "-", error: "canon recovery pending; run: kizuki recover --json" });
  }
  if (canonRecovery.quarantine.state === "unsafe") {
    problems.push({ page: ".kizuki/quarantine", error: "quarantine is not a private directory tree (each level must be a directory you own with mode 0700); inside the vault run: chmod 700 .kizuki/quarantine .kizuki/quarantine/canon-stage" });
  } else if (canonRecovery.quarantined > 0) {
    problems.push({ page: ".kizuki/quarantine/canon-stage", error: `${canonRecovery.quarantined} foreign canon stage file(s) kept in quarantine for inspection` });
  }
  for (const item of vault.doctrine) {
    if (item.state === "current" || item.state === "owner-edited") continue;
    problems.push({ page: item.file, error: `doctrine ${item.state}` });
  }
  for (const item of vault.control) {
    problems.push({ page: item.path, error: item.problem });
  }
  for (const failure of ledger.failures) {
    problems.push({
      page: "-",
      error: `ledger ${failure.kind} ${failure.table}: ${failure.detail}`,
    });
  }
  const purge = inspectPurgeHealth(ctx.db);
  for (const failure of purge.failures) {
    problems.push({
      page: "-",
      error:
        failure.kind === "purge_op_stale"
          ? `purge_op ${failure.id} pending for ${failure.age_s}s (SLA ${PURGE_SLA_SECONDS}s)`
          : `canon hold ${failure.id} pending for ${failure.age_s}s (SLA ${PURGE_SLA_SECONDS}s)`,
    });
  }
  const hashDriftResult = hashDrift(ctx, pageReport);
  problems.push(...hashDriftResult.problems);

  const freshness = indexFreshness(ctx.db, vaultPath);
  for (const reason of freshness.degraded) {
    problems.push({ page: "-", error: reason });
  }

  let effective: Record<string, unknown> = {};
  try {
    effective = effectiveVaultConfig(loadVaultConfig(vaultPath));
  } catch (error) {
    problems.push({ page: "-", error: errorText(error) });
  }

  const unhealthy = connections.some((item) => item.state !== "disconnected" && item.state !== "paused" && (item.health !== "ok" || item.hold !== null));
  const host = serveSupervisorHost(env, vaultPath);
  let boundModel: ModelBindingSummary | null = null;
  let modelConfigError: string | null = null;
  try {
    boundModel = await withDeadline(HEALTH_DEADLINE_MS, () => inspectModelBinding(ctx.vaultPath, env), "model inspection");
  } catch (error) {
    // The port's config refusals are fixed text naming the key, never a value.
    if (error instanceof PortError && error.code === "config_invalid") modelConfigError = clean(error.message);
    // Existing invalid/unbound model configuration remains an explicit disabled
    // writer diagnostic. Pending transactions, custody failures, and inspection
    // deadlines need recovery rather than a silent unbound report.
    const timedOut = errorText(error).includes("timed out");
    if (timedOut || (error instanceof Error && "code" in error &&
        ["transaction_unavailable", "custody_unavailable"].includes(String(error.code)))) {
      const hint = serveTomlModeHint(vaultPath);
      problems.push({ page: "-", error: `model configuration inspection unavailable${hint === null ? "" : `: ${hint}`}` });
    }
  }
  // Without the daemon's secret this process cannot bind the model, but the
  // reference is still known, and the daemon's receipts are filed under it.
  const configuredModel = boundModel ?? configuredModelBinding(ctx.vaultPath);
  const serve = inspectServeDoctor(ctx.db, vaultPath, {
    supervisor: host,
    model_ref: boundModel?.model_ref ?? null,
    reasoning_effort: boundModel?.reasoning_effort ?? null,
    embedding_configured: embeddingConfigured(vaultPath),
    judge: configuredJudgeDestination(vaultPath),
    pages: pageReport,
    ...(configuredModel === null ? {} : { configured_model_ref: configuredModel.model_ref }),
  });
  const ok =
    vault.counts.invalid === 0 &&
    orphans.length === 0 &&
    !unhealthy &&
    purge.ok &&
    serve.ok &&
    freshness.fresh &&
    problems.length === 0;

  const { live: liveClaims, filed: filedClaims } = readDoctorSampleClaims(ctx.db);
  const worldKinds = inspectWorldKindCoverage(ctx.db);
  const memt = await inspectMemtForDoctor(vaultPath, env);

  return {
    config,
    vault: vaultPath,
    vault_id: readVaultId(vaultPath),
    effective_config: effective,
    events: count(ctx.db),
    claims: claimSummary,
    live_claims: liveClaims,
    filed_claims: filedClaims,
    connections,
    receipts: receiptCount,
    orphans,
    holds,
    problems,
    hash_drift: hashDriftResult.coverage,
    serve,
    model_config_error: modelConfigError,
    doctrine: vault.doctrine,
    ledger,
    runtime: readSqliteRuntime(ctx.db),
    canon_recovery: canonRecovery,
    world_kinds: worldKinds,
    memt,
    ok: ok && ledger.ok,
  };
}

function printHuman(io: CliIo, report: DoctorReport): void {
  io.out("Kizuki doctor");
  io.out(`config=${report.config}`);
  io.out(`vault=${report.vault}`);
  if (report.vault_id !== null) io.out(`vault_id=${report.vault_id}`);
  io.out(`events=${report.events}`);
  io.out(
    `ledger schema=${report.ledger.schema_version ?? "-"} quick_check=${report.ledger.quick_check} sampled=${report.ledger.sampled_events}`,
  );
  const producers = report.claims.by_producer;
  io.out(
    `claims live=${report.claims.live} filed=${report.claims.filed} written=${report.claims.written} unwritten=${report.claims.unwritten} superseded=${report.claims.superseded} skipped=${report.claims.skipped} purged=${report.claims.purged}` +
      ` live_by_producer model_extracted=${producers.model} deterministic_floor=${producers.deterministic} owner=${producers.owner} agent=${producers.agent}`,
  );
  const fanout = report.claims.capture_fanout;
  io.out(
    `capture fan-out skipped=${fanout.skipped} pending=${fanout.pending}` +
      (fanout.pending > 0 ? " repair: kizuki serve run doctor-sweep" : ""),
  );
  const derived = report.serve.stores.derived;
  io.out(
    `derived search=${derived.search.rebuilt_at ?? "never"} docs=${derived.search.doc_count} watermark=${clean(derived.search.ledger_watermark ?? "none")} graph=${derived.graph.rebuilt_at ?? "never"} docs=${derived.graph.doc_count} watermark=${clean(derived.graph.ledger_watermark ?? "none")}`,
  );
  io.out(report.serve.stores.vector_layer.detail);
  io.out(
    `world kinds active=${report.world_kinds.active_kinds}/${report.world_kinds.total_kinds} populated=${report.world_kinds.populated_kinds}/${report.world_kinds.total_kinds} offered=${report.world_kinds.offered_kinds}/${report.world_kinds.total_kinds}`,
  );
  io.out(report.memt.detail);
  const stores = report.serve.stores;
  if (stores.skipped_pages_total > 0) {
    io.out(`index-degraded: ${stores.skipped_pages_total} canon file(s) cannot be indexed`);
    for (const page of stores.skipped_pages) io.out(`skipped ${clean(page.path)} (${page.reason})`);
    const hidden = stores.skipped_pages_total - stores.skipped_pages.length;
    if (hidden > 0) io.out(`skipped ... and ${hidden} more`);
  }
  if (stores.held_pages > 0) {
    io.out(`index-degraded: ${stores.held_pages} canon page(s) are held out of the index by an open hold or write; kizuki rebuild does not clear them`);
  }
  if (stores.pages_truncated) {
    io.out("canon walk truncated: the skipped-file list above may be incomplete");
  }
  if (stores.skipped_pages_total === 0 && stores.held_pages === 0) {
    // Compatibility: a vault not yet visited by an incremental pass can retain an old stamp.
    for (const layer of ["search", "graph"] as const) {
      const stamp = derived[layer];
      if (stamp.status !== null && stamp.status !== "ok" && stamp.skipped_count > 0) {
        io.out(`derived ${layer} stamp is ${stamp.status} with ${stamp.skipped_count} skipped, but no canon file is skipped or held now; the stamp may be stale; the next incremental pass re-evaluates it`);
      }
    }
  }
  const capacity = report.serve.canon;
  if (capacity !== null) {
    io.out(
      `canon pages live=${capacity.live} archived=${capacity.archived} ceiling=${capacity.ceiling} state=${capacity.state}` +
        (capacity.next === null ? "" : ` next: ${capacity.next}`),
    );
  }
  const writers = report.serve.stores.writers;
  io.out(
    `writers loop=${writers.loop} correction=${writers.correction} import=${writers.import} revert=${writers.revert}`,
  );
  const origin = report.serve.stores.origin;
  io.out(`origin machine=${origin.machine} human=${origin.human}`);
  const calibration = report.serve.calibration;
  io.out(
    `calibration write_rate=${calibration.write_rate === null ? "-" : calibration.write_rate.toFixed(3)} spread=${calibration.confidence_spread === null ? "-" : calibration.confidence_spread.toFixed(3)} failures=${calibration.failures.length}`,
  );
  const ports = report.effective_config["ports"];
  if (typeof ports === "object" && ports !== null && "llm" in ports) {
    io.out(`ports.llm=${String((ports as { llm: unknown }).llm)}`);
  }
  for (const claim of report.live_claims) {
    io.out(
      `claim ${claim.claim_id} target=${claim.target ?? "-"} predicate=${claim.predicate ?? "-"}`,
    );
  }
  for (const claim of report.filed_claims) {
    io.out(
      `filed ${claim.claim_id} target=${claim.target ?? "-"} predicate=${claim.predicate ?? "-"}`,
    );
  }
  for (const item of report.connections) {
    const reason = item.last_error === null ? "" : ` last_error=${JSON.stringify(item.last_error)}`;
    const line = `connection ${item.connector_id} source=${item.source_key} path=${item.path} state=${item.state} health=${item.health} checkpoint=${item.checkpoint} stored=${item.stored} errors=${item.errors} last_run_clean=${item.last_run_clean ? "yes" : "no"}${reason}`;
    io.out(item.problem === null ? line : `${line} ${item.problem}`);
    for (const detail of sourceCoverageLines(item.coverage)) io.out(detail);
    if (item.hold !== null) io.out(`source-hold ${item.connector_id} source=${item.source_key} ${withdrawalHoldLine(item.connector_id, item.source_key, item.hold)}`);
  }
  io.out(`receipts=${report.receipts} orphans=${report.orphans.length}`);
  io.out(hashDriftCoverageLine(report.hash_drift));
  for (const orphan of report.orphans) io.out(orphan);
  for (const hold of report.holds) {
    io.out(`hold ${hold.page_path} id=${hold.id}`);
  }
  for (const item of report.doctrine) {
    if (item.state === "owner-edited") io.out(`doctrine ${item.file}: owner-edited`);
  }
  for (const stage of report.canon_recovery.stages) {
    if (stage.present) io.out(`canon-stage ${stage.stage} ${stage.path} classification=${stage.classification} next_start=${stage.action_on_next_start}`);
  }
  for (const problem of report.problems) {
    io.out(`problem ${problem.page}: ${problem.error}`);
  }
  io.out(report.serve.supervisor.detail);
  io.out(report.serve.model.detail);
  io.out(report.serve.extraction.detail);
  io.out(report.serve.consolidation.detail);
  io.out(report.serve.attention.detail);
  for (const source of report.serve.egress) {
    io.out(`egress source=${source.source_key} connector=${source.connector_id} host=${clean(source.endpoint_host)} model=${clean(source.model)} retention=${source.retention} (${RETENTION_MEANING[source.retention]})`);
    if (source.judge !== null) {
      io.out(`egress source=${source.source_key} judge host=${clean(source.judge.host)} model=${clean(source.judge.model)} retention=logged_and_trained (undeclared)${source.judge.consented ? "" : "; held: judge not consented; check egress judge_endpoint, judge_model and external_retention"}`);
    }
  }
  if (report.model_config_error !== null) io.out(`model configuration invalid: ${report.model_config_error}`);
  io.out(report.serve.throughput.detail);
  io.out(report.serve.oversized.detail);
  io.out(report.serve.quarantined.detail);
  for (const page of report.serve.quarantined.pages) {
    io.out(`quarantined ${page.path} handle=${page.handle} failed_passes=${page.attempts} until=${page.until} last_error=${JSON.stringify(page.reason)}`);
  }
  for (const claim of report.serve.quarantined.claims ?? []) {
    io.out(`unmaterialized claim=${JSON.stringify(claim.claim_id)} failed_passes=${claim.attempts} until=${claim.until} last_error=${JSON.stringify(claim.reason)}`);
  }
  for (const rail of report.serve.rails) {
    const extra = rail.reason === null ? "" : ` ${rail.reason}`;
    io.out(`rail ${rail.rail} status=${rail.status}${rail.rail === "verify-world" ? ` last_result=${rail.last_result ?? "never"} age_s=${rail.age_s ?? "unknown"}` : ""}${extra}`);
  }
  for (const failure of report.serve.failures) {
    io.out(`serve-failure ${supervisorFailureLine(failure, report.serve.supervisor, report.serve.supervisor_exit, report.vault)}`);
  }
  io.out(`status=${report.ok ? "ok" : "failed"}`);
  const next = nextStep({ ...report, held: report.connections.flatMap((item) => item.hold === null ? [] : [{ connector_id: item.connector_id, source_key: item.source_key, hold: item.hold }]) });
  if (next !== null) io.out(next);
}
