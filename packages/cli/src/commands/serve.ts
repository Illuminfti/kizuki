import { resolve } from "node:path";
import {
  detectSupervisorKind,
  inspectServeDoctor,
  installServeService,
  isCrashPoint,
  isRailId,
  queryServeService,
  readServePid,
  realSupervisorHost,
  runRail,
  runServeDaemon,
  serveExecHint,
  thisProcess,
  uninstallServeService,
  writeServeIntent,
} from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import type { CliIo, Command } from "./index";

function execStart(vaultPath: string): string {
  const bun = process.execPath;
  const entry = resolve(import.meta.dir, "../main.ts");
  return `${bun} ${entry} serve --vault ${vaultPath}`;
}

function homeOf(io: CliIo): string {
  return io.env.HOME ?? io.env.XDG_CONFIG_HOME ?? "";
}

export const serveCommand: Command = {
  name: "serve",
  usage:
    "serve [--once] [--no-http] [--port N] [--json] [--install] [--uninstall] | serve status [--json] | serve stop | serve run <rail> [--json]",
  summary: "run the always-on loop, or install it as a user service",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      flags: ["--once", "--no-http", "--json", "--install", "--uninstall"],
      options: ["--port", "--crash-after"],
    });
    const [verb, rail] = parsed.positionals;

    return withVault(io, async (ctx) => {
      const kind = detectSupervisorKind(io.env);
      const host = realSupervisorHost(kind, homeOf(io), execStart(ctx.vaultPath));

      if (parsed.flags.has("--install")) {
        if (kind === "none") {
          writeServeIntent(ctx.vaultPath, "none");
          io.out("supervisor: none (loop runs only while you run it)");
          io.out(`run: ${serveExecHint(ctx.vaultPath)}`);
          return 0;
        }
        const result = installServeService(ctx.vaultPath, host);
        if (parsed.flags.has("--json")) io.out(jsonEnvelope("serve", "ok", result));
        else {
          io.out(`supervisor=${result.status.kind} state=${result.status.state}`);
          if (result.unitPath !== null) io.out(`unit=${result.unitPath}`);
        }
        return 0;
      }

      if (parsed.flags.has("--uninstall")) {
        const result = uninstallServeService(ctx.vaultPath, host);
        if (parsed.flags.has("--json")) io.out(jsonEnvelope("serve", "ok", result));
        else io.out(`supervisor=${result.status.kind} state=${result.status.state} removed=${result.removed}`);
        return 0;
      }

      if (verb === "status") {
        const supervisor = queryServeService(ctx.vaultPath, host);
        const doctor = inspectServeDoctor(ctx.db, ctx.vaultPath, { supervisor: host });
        const pid = readServePid(ctx.vaultPath);
        const body = { pid, supervisor, doctor };
        if (parsed.flags.has("--json")) {
          io.out(jsonEnvelope("serve", doctor.ok ? "ok" : "error", body));
        }
        else {
          io.out(`pid=${pid ?? "none"} supervisor=${supervisor.kind} state=${supervisor.state}`);
          io.out(supervisor.detail);
        }
        return doctor.ok ? 0 : 1;
      }

      if (verb === "stop") {
        const pid = readServePid(ctx.vaultPath);
        if (pid === null) {
          io.err("serve is not running");
          return 1;
        }
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          io.err("serve is not running");
          return 1;
        }
        io.out(`stopped pid=${pid}`);
        return 0;
      }

      if (verb === "run") {
        if (rail === undefined || !isRailId(rail)) throw new UsageError(this.usage);
        const crashAfter = parsed.options.get("--crash-after");
        const receipt = await runRail(ctx.db, ctx.vaultPath, rail, {
          ...(crashAfter !== undefined && isCrashPoint(crashAfter)
            ? { crashAfter }
            : {}),
        });
        if (parsed.flags.has("--json")) {
          io.out(
            jsonEnvelope(
              "serve",
              receipt.status === "failed" ? "error" : receipt.status === "ok" ? "ok" : "degraded",
              receipt,
            ),
          );
        }
        else io.out(`rail=${receipt.rail} status=${receipt.status} run_id=${receipt.run_id}`);
        return receipt.status === "failed" ? 1 : 0;
      }

      if (verb !== undefined) throw new UsageError(this.usage);

      const portRaw = parsed.options.get("--port");
      const port = portRaw === undefined ? undefined : Number.parseInt(portRaw, 10);
      if (portRaw !== undefined && (!Number.isInteger(port) || (port ?? 0) < 0)) {
        throw new UsageError(this.usage);
      }
      const crashAfter = parsed.options.get("--crash-after");
      const result = await runServeDaemon(ctx.db, ctx.vaultPath, {
        once: parsed.flags.has("--once"),
        http: !parsed.flags.has("--no-http"),
        ...(port === undefined ? {} : { port }),
        ...(crashAfter !== undefined && isCrashPoint(crashAfter)
          ? { crashAfter }
          : {}),
        process: thisProcess(),
      });
      if (parsed.flags.has("--json")) {
        io.out(
          jsonEnvelope("serve", "ok", {
            receipts: result.receipts,
            http:
              result.http === null
                ? null
                : { host: result.http.host, port: result.http.port, token_path: result.http.tokenPath },
          }),
        );
      } else {
        io.out(`receipts=${result.receipts}`);
        if (result.http !== null) {
          io.out(`http=${result.http.url}`);
          io.out(`token_path=${result.http.tokenPath}`);
        }
      }
      if (result.http !== null) await result.http.stop();
      return 0;
    });
  },
};
