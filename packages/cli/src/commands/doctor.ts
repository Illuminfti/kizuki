import {
  CLAIM_STATUSES,
  PURGE_SLA_SECONDS,
  count,
  countClaims,
  detectSupervisorKind,
  doctorVault,
  getCanonReceipt,
  getCheckpoint,
  inspectPurgeHealth,
  inspectServeDoctor,
  listClaims,
  readHolds,
  readReceiptsLog,
  realSupervisorHost,
} from "@kizuki/core";
import type { ClaimStatus } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { listHostConnections, loadConnector } from "../connections";
import { withVault } from "../context";
import type { VaultContext } from "../context";
import { errorText, jsonLine } from "../output";
import type { CliIo, Command } from "./index";

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

interface DoctorReport {
  config: string;
  vault: string;
  events: number;
  claims: Record<ClaimStatus, number>;
  live_claims: DoctorClaim[];
  filed_claims: DoctorClaim[];
  connections: DoctorConnection[];
  receipts: number;
  orphans: string[];
  holds: { page_path: string; id: string }[];
  problems: { page: string; error: string }[];
  serve: ReturnType<typeof inspectServeDoctor>;
  ok: boolean;
}

interface DoctorClaim {
  claim_id: string;
  target: string | null;
  predicate: string | null;
}

export const doctorCommand: Command = {
  name: "doctor",
  usage: "doctor [--json]",
  summary: "report vault, connection, receipt, claim, and hold health",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { flags: ["--json"] });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);

    return withVault(io, async (ctx) => {
      const report = await collect(ctx.configPath, ctx.vaultPath, ctx, io.env);
      if (parsed.flags.has("--json")) {
        io.out(jsonLine(report));
        return report.ok ? 0 : 1;
      }
      printHuman(io, report);
      return report.ok ? 0 : 1;
    });
  },
};

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
        problem: host.problem,
      });
      continue;
    }
    try {
      const connector = await loadConnector(host);
      const health = await connector.health();
      connections.push({
        ...base,
        path: host.state.config.path,
        state: "present",
        health: health.state,
        problem: health.state === "ok" ? null : (health.detail ?? null),
      });
    } catch (error) {
      connections.push({
        ...base,
        path: host.state.config.path,
        state: "present",
        health: "misconfigured",
        problem: errorText(error),
      });
    }
  }

  const log = readReceiptsLog(vaultPath);
  const orphans: string[] = [];
  for (const receipt of log) {
    if (getCanonReceipt(ctx.db, receipt.receipt_id) === null) {
      orphans.push(`orphan receipt ${receipt.receipt_id} (no canon_receipts row)`);
    }
  }

  const holds = readHolds(ctx.db).map((hold) => ({
    page_path: hold.page_path,
    id: hold.proposal_id,
  }));

  const vault = doctorVault(vaultPath);
  const problems = vault.pages.flatMap((page) =>
    page.errors.map((error) => ({ page: page.page, error })),
  );
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

  const unhealthy = connections.some((item) => item.health !== "ok");
  const kind = detectSupervisorKind(env);
  const host = realSupervisorHost(
    kind,
    env.HOME ?? env.XDG_CONFIG_HOME ?? "",
    `kizuki serve --vault ${vaultPath}`,
  );
  const serve = inspectServeDoctor(ctx.db, vaultPath, { supervisor: host });
  const ok =
    vault.counts.invalid === 0 &&
    orphans.length === 0 &&
    !unhealthy &&
    purge.ok &&
    serve.ok;

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
    events: count(ctx.db),
    claims,
    live_claims: liveClaims,
    filed_claims: filedClaims,
    connections,
    receipts: log.length,
    orphans,
    holds,
    problems,
    serve,
    ok,
  };
}

function printHuman(io: CliIo, report: DoctorReport): void {
  io.out("Kizuki doctor");
  io.out(`config=${report.config}`);
  io.out(`vault=${report.vault}`);
  io.out(`events=${report.events}`);
  io.out(
    `claims live=${report.claims.live} superseded=${report.claims.superseded} skipped=${report.claims.skipped} purged=${report.claims.purged}`,
  );
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
      "next: ingest filed claims; tell --claim needs a live claim. the writer is off until a model is configured.",
    );
  }
}
