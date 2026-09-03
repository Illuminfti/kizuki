import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  PURGE_SLA_SECONDS,
  count,
  detectSupervisorKind,
  doctorVault,
  getCanonReceipt,
  getCheckpoint,
  inspectPurgeHealth,
  inspectServeDoctor,
  readHolds,
  realSupervisorHost,
} from "@kizuki/core";
import {
  listProposals,
  readPromotion,
  readReceiptsLog,
} from "@kizuki/core/staging";
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
  proposals: {
    pending: number;
    promoted: number;
    rejected: number;
    withdrawn: number;
  };
  connections: DoctorConnection[];
  receipts: number;
  orphans: string[];
  holds: { page_path: string; proposal_id: string }[];
  retractions: { proposal_id: string; page: string }[];
  problems: { page: string; error: string }[];
  serve: ReturnType<typeof inspectServeDoctor>;
  ok: boolean;
}

export const doctorCommand: Command = {
  name: "doctor",
  usage: "doctor [--json]",
  summary: "report vault, connection, receipt, and hold health",
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
  const proposals = {
    pending: listProposals(ctx.db, { status: "pending", limit: 100000 }).length,
    promoted: listProposals(ctx.db, { status: "promoted", limit: 100000 })
      .length,
    rejected: listProposals(ctx.db, { status: "rejected", limit: 100000 })
      .length,
    withdrawn: listProposals(ctx.db, { status: "withdrawn", limit: 100000 })
      .length,
  };

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

  const promoted = listProposals(ctx.db, {
    status: "promoted",
    limit: 100000,
  });
  for (const proposal of promoted) {
    const promotion = readPromotion(ctx.db, proposal.proposal_id);
    if (promotion === null) continue;
    if (!existsSync(join(vaultPath, promotion.page_path))) {
      orphans.push(
        `orphan promotion ${promotion.receipt_id} page=${promotion.page_path} (missing on disk)`,
      );
    }
  }

  const holds = readHolds(ctx.db).map((hold) => ({
    page_path: hold.page_path,
    proposal_id: hold.proposal_id,
  }));
  const retractions = listProposals(ctx.db, {
    kind: "deletion",
    status: "pending",
    limit: 100000,
  }).map((proposal) => ({
    proposal_id: proposal.proposal_id,
    page: `${proposal.target ?? ""}.md`,
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

  return {
    config,
    vault: vaultPath,
    events: count(ctx.db),
    proposals,
    connections,
    receipts: log.length,
    orphans,
    holds,
    retractions,
    problems,
    serve,
    ok,
  };
}

function printHuman(io: CliIo, report: DoctorReport): void {
  io.out(`config=${report.config}`);
  io.out(`vault=${report.vault}`);
  io.out(`events=${report.events}`);
  io.out(
    `proposals pending=${report.proposals.pending} promoted=${report.proposals.promoted} rejected=${report.proposals.rejected} withdrawn=${report.proposals.withdrawn}`,
  );
  for (const item of report.connections) {
    const line = `connection ${item.connector_id} source=${item.source_key} path=${item.path} state=${item.state} health=${item.health} checkpoint=${item.checkpoint} stored=${item.stored} errors=${item.errors}`;
    io.out(item.problem === null ? line : `${line} ${item.problem}`);
  }
  io.out(`receipts=${report.receipts} orphans=${report.orphans.length}`);
  for (const orphan of report.orphans) io.out(orphan);
  for (const hold of report.holds) {
    io.out(`hold ${hold.page_path} proposal=${hold.proposal_id}`);
  }
  for (const retraction of report.retractions) {
    io.out(
      `retraction-pending ${retraction.proposal_id} page=${retraction.page}`,
    );
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
}
