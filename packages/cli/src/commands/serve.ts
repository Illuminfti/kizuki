import {
  detectSupervisorKind,
  inspectServeDoctor,
  installServeService,
  isCrashPoint,
  isRailId,
  queryServeService,
  readServePid,
  requestServeStop,
  ServeStopError,
  runRail,
  runServeDaemon,
  serveExecHint,
  systemdUnitName,
  thisProcess,
  uninstallServeService,
} from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import type { CliIo, Command, CommandHelpSchema } from "./index";
import { serveSupervisorHost } from "../service-host";
import { createServeRuntime } from "../serve-runtime";
import { runServiceCustodyBroker, startServiceCustody, ServiceCustodyError, type ServiceCustodyHandle } from "@kizuki/core/internal";
import { custodyUnavailableMessage, launchServiceCustodyBroker } from "../service-custody";
import { isAbsolute, resolve } from "node:path";

/** Supervisor-only launch modes. Parsed so installed units can start; omitted from public help. */
const PRIVATE_LAUNCH_MODES = [
  "--service-custody",
  "--custody-broker-launch",
  "--custody-broker-child",
] as const;

export const SERVE_SCHEMA = {
  options: ["--port", "--crash-after"],
  flags: ["--once", "--no-http", "--json", "--install", "--uninstall"],
} as const satisfies CommandHelpSchema;

export const serveCommand: Command = {
  name: "serve",
  usage:
    "serve [--once] [--no-http] [--port N] [--json] [--install] [--uninstall] | serve status [--json] | serve stop | serve run <rail> [--json]",
  summary: "run the always-on loop, or install it as a user service",
  schema: SERVE_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...SERVE_SCHEMA.options, ...PRIVATE_LAUNCH_MODES],
      flags: [...SERVE_SCHEMA.flags],
    });
    const [verb, rail] = parsed.positionals;
    const portRaw = parsed.options.get("--port");
    const port = portRaw === undefined ? undefined : Number(portRaw);
    if (portRaw !== undefined && (
      portRaw.length === 0 || /[^0-9]/.test(portRaw) ||
      port === undefined || !Number.isInteger(port) || port < 0 || port > 65535
    )) {
      throw new UsageError(this.usage);
    }
    const modes = PRIVATE_LAUNCH_MODES.filter(mode => parsed.options.has(mode));
    if (modes.length > 1) throw new ServiceCustodyError();
    let custody: ServiceCustodyHandle | undefined;
    if (modes.length === 1) {
      if (verb !== undefined || parsed.flags.size !== 0 || parsed.options.size !== 1 ||
          io.vaultOverride === null || !isAbsolute(io.vaultOverride) || resolve(io.vaultOverride) !== io.vaultOverride) {
        throw new ServiceCustodyError();
      }
      const mode = modes[0]!, id = parsed.options.get(mode)!, vault = io.vaultOverride;
      // The service log is the only place these failures are read, so they
      // carry what the refusal observed instead of a bare code. The unit name
      // is derived, not queried: this process is the unit. An id core would
      // refuse names no unit, so the message omits it rather than echo it.
      const unit = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id) ? systemdUnitName(id) : null;
      try {
        if (mode === "--custody-broker-launch") {
          await launchServiceCustodyBroker(vault, id, io.env);
          return 0;
        }
        if (mode === "--custody-broker-child") return runServiceCustodyBroker(vault, id, io.env);
        custody = await startServiceCustody(vault, id, io.env, () => {
          // Lost metadata authority is a daemon failure, including while a rail
          // would otherwise catch an adapter error. Durable recovery handles the
          // same boundary as a killed service; never continue with stale custody.
          io.err(custodyUnavailableMessage(vault, unit, "custody_lost"));
          process.exit(1);
        });
      } catch (error) {
        if (!(error instanceof ServiceCustodyError)) throw error;
        io.err(custodyUnavailableMessage(vault, unit, error.reason));
        return 1;
      }
    }
    try { return await withVault(io, async (ctx) => {
      const kind = detectSupervisorKind(io.env);
      const host = serveSupervisorHost(io.env, ctx.vaultPath);

      if (parsed.flags.has("--install")) {
        if (kind === "none") {
          installServeService(ctx.vaultPath, host);
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
        try {
          const result = await requestServeStop(ctx.vaultPath);
          if (parsed.flags.has("--json")) io.out(jsonEnvelope("serve", "ok", result));
          else io.out(result.status === "queued" ? "stop request queued" : "stop request already queued");
          return 0;
        } catch (error) {
          if (!(error instanceof ServeStopError)) throw error;
          io.err(error.message);
          return 1;
        }
      }

      if (verb === "run") {
        if (rail === undefined || !isRailId(rail)) throw new UsageError(this.usage);
        const crashAfter = parsed.options.get("--crash-after");
        const receipt = await runRail(ctx.db, ctx.vaultPath, rail, {
          acquireRuntime: () => createServeRuntime({ ...ctx, env: io.env, err: io.err }),
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

      const crashAfter = parsed.options.get("--crash-after");
      const result = await runServeDaemon(ctx.db, ctx.vaultPath, {
        once: parsed.flags.has("--once"),
        http: !parsed.flags.has("--no-http"),
        ...(port === undefined ? {} : { port }),
        ...(crashAfter !== undefined && isCrashPoint(crashAfter)
          ? { crashAfter }
          : {}),
        process: thisProcess(),
        acquireRuntime: () => createServeRuntime({ ...ctx, env: io.env, err: io.err, configurationErrorMode: "disable-model" }),
        ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }),
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
    }, { retrieval: verb === "status" || verb === "stop" || parsed.flags.has("--install") || parsed.flags.has("--uninstall") ? "none" : "required" });
    } finally { custody?.close(); }
  },
};
