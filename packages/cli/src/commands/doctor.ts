import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAIM_STATUSES,
  PURGE_SLA_SECONDS,
  count,
  countClaims,
  countUnwrittenLiveClaims,
  countWrittenLiveClaims,
  detectSupervisorKind,
  doctorVault,
  getCanonReceipt,
  getCheckpoint,
  inspectPurgeHealth,
  inspectServeDoctor,
  latestReceiptForPage,
  listClaims,
  listCanonPages,
  readHolds,
  readVaultId,
  realSupervisorHost,
} from "@kizuki/core";
import type { ClaimStatus } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { listHostConnections, loadConnector } from "../connections";
import { withVault } from "../context";
import type { VaultContext } from "../context";
import { countCanonReceiptRows, indexFreshness, walkCanonReceipts } from "../derived";
import { clean, errorText, jsonEnvelope } from "../output";
import { effectiveVaultConfig, loadVaultConfig } from "../vault-config";
import { createServeRuntime } from "../serve-runtime";
import type { CliIo, Command } from "./index";

const HEALTH_DEADLINE_MS = 3_000;
const HASH_DRIFT_CAP = 64;
const DETAIL_CAP = 160;

interface DoctorConnection {
  connector_id: string;
  source_key: string;
  path: string;
  state: "present" | "missing";
  health: string;
  checkpoint: string;
  stored: number;
  errors: number;
  problem: string | null;
}

interface DoctorClaim {
  claim_id: string;
  target: string | null;
  predicate: string | null;
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
  };
  live_claims: DoctorClaim[];
  filed_claims: DoctorClaim[];
  connections: DoctorConnection[];
  receipts: number;
  orphans: string[];
  holds: { page_path: string; id: string }[];
  problems: { page: string; error: string }[];
  serve: ReturnType<typeof inspectServeDoctor>;
  doctrine: { file: string; state: string }[];
  ok: boolean;
}

export const doctorCommand: Command = {
  name: "doctor",
  usage: "doctor [--json]",
  summary: "verify vault identity, receipts, indexes, rails, and connection health",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { flags: ["--json"] });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);

    return withVault(io, async (ctx) => {
      const report = await collect(ctx.configPath, ctx.vaultPath, ctx, io.env);
      if (parsed.flags.has("--json")) {
        io.out(
          jsonEnvelope("doctor", report.ok ? "ok" : "error", report, {
            degraded: report.problems.map((problem) => problem.error),
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

async function withDeadline<T>(ms: number, work: () => Promise<T>): Promise<T> {
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
        timer = setTimeout(() => reject(new Error("health timed out")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function reconcileReceipts(vaultPath: string, ctx: VaultContext): string[] {
  const orphans: string[] = [];
  const path = join(vaultPath, ".kizuki", "receipts", "promotions.jsonl");
  const seen = new Set<string>();
  if (existsSync(path)) {
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        orphans.push(`torn JSONL line ${index + 1}`);
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || !("receipt_id" in parsed)) {
        orphans.push(`invalid JSONL line ${index + 1}`);
        continue;
      }
      const receiptId = (parsed as { receipt_id: unknown }).receipt_id;
      if (typeof receiptId !== "string" || receiptId.length === 0) {
        orphans.push(`invalid JSONL line ${index + 1}`);
        continue;
      }
      if (seen.has(receiptId)) {
        orphans.push(`duplicate receipt ${receiptId}`);
        continue;
      }
      seen.add(receiptId);
      if (getCanonReceipt(ctx.db, receiptId) === null) {
        orphans.push(`orphan receipt ${receiptId} (no canon_receipts row)`);
      }
    }
  }

  for (const row of walkCanonReceipts(ctx.db)) {
    if (!seen.has(row.receipt_id)) {
      orphans.push(`orphan row ${row.receipt_id} (no JSONL line)`);
    }
  }
  return orphans;
}

function hashDrift(vaultPath: string, ctx: VaultContext): { page: string; error: string }[] {
  const problems: { page: string; error: string }[] = [];
  const pages = listCanonPages(vaultPath).slice(0, HASH_DRIFT_CAP);
  for (const page of pages) {
    const latest = latestReceiptForPage(ctx.db, page.relPath);
    if (latest === null) continue;
    const absolute = join(vaultPath, page.relPath);
    if (!existsSync(absolute)) {
      problems.push({
        page: page.relPath,
        error: `hash drift: live page missing (receipt ${latest.receipt_id})`,
      });
      continue;
    }
    const actual = new Bun.CryptoHasher("sha256")
      .update(readFileSync(absolute))
      .digest("hex");
    if (actual !== latest.after_hash) {
      problems.push({
        page: page.relPath,
        error: `hash drift: file disagrees with receipt ${latest.receipt_id}`,
      });
    }
  }
  return problems;
}

async function collect(
  config: string,
  vaultPath: string,
  ctx: VaultContext,
  env: Record<string, string | undefined>,
): Promise<DoctorReport> {
  const claims = Object.fromEntries(
    CLAIM_STATUSES.map((status) => [
      status,
      countClaims(ctx.db, { status }),
    ]),
  ) as Record<ClaimStatus, number>;

  const connections: DoctorConnection[] = [];
  for (const host of listHostConnections(ctx.db, ctx.store)) {
    const checkpoint = getCheckpoint(
      ctx.db,
      host.connection.connector_id,
      host.connection.source_key,
    );
    const base = {
      connector_id: host.connection.connector_id,
      source_key: host.connection.source_key,
      checkpoint: checkpoint?.last_run_at ?? "never",
      stored: checkpoint?.last_result.stored ?? 0,
      errors: checkpoint?.last_result.errors.length ?? 0,
    };
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
      const connector = await loadConnector(host, ctx.store);
      const health = await withDeadline(HEALTH_DEADLINE_MS, () => connector.health());
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

  const orphans = reconcileReceipts(vaultPath, ctx);
  const holds = readHolds(ctx.db).map((hold) => ({
    page_path: hold.page_path,
    id: hold.proposal_id,
  }));

  const vault = doctorVault(vaultPath);
  const problems = vault.pages.flatMap((page) =>
    page.errors.map((error) => ({ page: page.page, error })),
  );
  for (const item of vault.doctrine) {
    if (item.state === "current" || item.state === "owner-edited") continue;
    problems.push({ page: item.file, error: `doctrine ${item.state}` });
  }
  for (const item of vault.control) {
    problems.push({ page: item.path, error: item.problem });
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
  problems.push(...hashDrift(vaultPath, ctx));

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

  const unhealthy = connections.some((item) => item.health !== "ok");
  const kind = detectSupervisorKind(env);
  const host = realSupervisorHost(
    kind,
    env.HOME ?? env.XDG_CONFIG_HOME ?? "",
    `kizuki serve --vault ${vaultPath}`,
  );
  let boundModelRef: string | null = null;
  try {
    const runtime = await createServeRuntime({ ...ctx, env, err: () => {} });
    try {
      boundModelRef = runtime.hooks.model_ref ?? null;
    } finally {
      await runtime.close();
    }
  } catch {
    // Doctor reports raw configuration as unverified below. Binding errors
    // never make a string configuration look like an enabled writer.
  }
  const serve = inspectServeDoctor(ctx.db, vaultPath, {
    supervisor: host,
    model_ref: boundModelRef,
  });
  const ok =
    vault.counts.invalid === 0 &&
    orphans.length === 0 &&
    !unhealthy &&
    purge.ok &&
    serve.ok &&
    freshness.fresh &&
    problems.length === 0;

  const toDoctorClaim = (claim: {
    claim_id: string;
    target: string | null;
    predicate: string | null;
  }): DoctorClaim => ({
    claim_id: claim.claim_id,
    target: claim.target,
    predicate: claim.predicate,
  });
  const liveClaims = listClaims(ctx.db, { status: "live", limit: 8 }).map(
    toDoctorClaim,
  );
  const filedClaims = listClaims(ctx.db, { status: "skipped", limit: 8 }).map(
    toDoctorClaim,
  );

  return {
    config,
    vault: vaultPath,
    vault_id: readVaultId(vaultPath),
    effective_config: effective,
    events: count(ctx.db),
    claims: {
      ...claims,
      filed: countClaims(ctx.db, { status: "skipped" }),
      written: countWrittenLiveClaims(ctx.db),
      unwritten: countUnwrittenLiveClaims(ctx.db),
    },
    live_claims: liveClaims,
    filed_claims: filedClaims,
    connections,
    receipts: countCanonReceiptRows(ctx.db),
    orphans,
    holds,
    problems,
    serve,
    doctrine: vault.doctrine,
    ok,
  };
}

function printHuman(io: CliIo, report: DoctorReport): void {
  io.out("Kizuki doctor");
  io.out(`config=${report.config}`);
  io.out(`vault=${report.vault}`);
  if (report.vault_id !== null) io.out(`vault_id=${report.vault_id}`);
  io.out(`events=${report.events}`);
  io.out(
    `claims live=${report.claims.live} filed=${report.claims.filed} written=${report.claims.written} unwritten=${report.claims.unwritten} superseded=${report.claims.superseded} skipped=${report.claims.skipped} purged=${report.claims.purged}`,
  );
  const derived = report.serve.stores.derived;
  io.out(
    `derived search=${derived.search.rebuilt_at ?? "never"} docs=${derived.search.doc_count} graph=${derived.graph.rebuilt_at ?? "never"} docs=${derived.graph.doc_count}`,
  );
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
    const line = `connection ${item.connector_id} source=${item.source_key} path=${item.path} state=${item.state} health=${item.health} checkpoint=${item.checkpoint} stored=${item.stored} errors=${item.errors}`;
    io.out(item.problem === null ? line : `${line} ${item.problem}`);
  }
  io.out(`receipts=${report.receipts} orphans=${report.orphans.length}`);
  for (const orphan of report.orphans) io.out(orphan);
  for (const hold of report.holds) {
    io.out(`hold ${hold.page_path} id=${hold.id}`);
  }
  for (const item of report.doctrine) {
    if (item.state === "owner-edited") io.out(`doctrine ${item.file}: owner-edited`);
  }
  for (const problem of report.problems) {
    io.out(`problem ${problem.page}: ${problem.error}`);
  }
  io.out(report.serve.supervisor.detail);
  io.out(report.serve.model.detail);
  for (const rail of report.serve.rails) {
    const extra = rail.reason === null ? "" : ` ${rail.reason}`;
    io.out(`rail ${rail.rail} status=${rail.status}${extra}`);
  }
  for (const failure of report.serve.failures) {
    io.out(`serve-failure ${failure}`);
  }
  io.out(`status=${report.ok ? "ok" : "failed"}`);
  const firstLive = report.live_claims[0];
  if (firstLive !== undefined) {
    io.out(`next: kizuki tell "<statement>" --claim ${firstLive.claim_id}`);
  } else if (report.filed_claims.length > 0) {
    io.out(
      "next: leftover skipped claims are not live; tell --claim needs a live claim. the writer is off until a model is configured.",
    );
  }
}
