import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MODEL_PRODUCER_ID,
  PortError,
  PortRegistry,
  createModelProducerPort,
  detectSupervisorKind,
  inspectServeDoctor,
  installServeService,
  isCrashPoint,
  isRailId,
  loadLlmPortSelection,
  parseSecretRef,
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
import type { LlmPort, RailHooks } from "@kizuki/core";
import { registerLlmPorts } from "@kizuki/llm";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import type { VaultContext } from "../context";
import { jsonEnvelope } from "../output";
import type { CliIo, Command } from "./index";

/**
 * Reads the value a validated `env:`/`file:` secret_ref names. The llm port
 * already rejected any other shape before this is ever called (RFC 0002
 * §12.1); a missing env var or file surfaces as `unavailable`, wrapped by
 * the port itself, never as a startup failure.
 */
async function resolveModelSecret(
  env: Record<string, string | undefined>,
  ref: string,
): Promise<string> {
  const parsed = parseSecretRef(ref);
  if (parsed === null) throw new Error("secret_ref is not a supported reference");
  if (parsed.scheme === "env") {
    const value = env[parsed.value];
    if (value === undefined || value.length === 0) {
      throw new Error(`secret env var ${parsed.value} is not set`);
    }
    return value;
  }
  return readFileSync(parsed.value, "utf8").trim();
}

interface ModelWiring {
  readonly hooks: RailHooks;
  close(): Promise<void>;
}

/**
 * Binds the vault's configured `[ports.llm]` selection to a real
 * `kizuki.llm/v1` port and the `kizuki.producer.model` producer, so the
 * loop can actually extract claims rather than merely carry a model label.
 * `null` when no model is configured — the vault behaves exactly as before.
 * A misconfigured secret_ref throws synchronously here, before any rail
 * runs, so `serve` fails closed instead of degrading silently later.
 */
function resolveModelWiring(ctx: VaultContext, env: Record<string, string | undefined>): ModelWiring | null {
  const selection = loadLlmPortSelection(ctx.vaultPath);
  if (selection === null) return null;

  const registry = new PortRegistry();
  registerLlmPorts(registry);
  const llmDataDir = join(ctx.vaultPath, ".kizuki", "llm", selection.id);
  mkdirSync(llmDataDir, { recursive: true, mode: 0o700 });

  let llm: LlmPort;
  try {
    ({ port: llm } = registry.bindFromConfig<LlmPort>("llm", { llm: selection.id }, {
      vault_path: ctx.vaultPath,
      data_dir: llmDataDir,
      config: selection.config,
      secrets: (ref) => resolveModelSecret(env, ref),
      clock: () => new Date().toISOString(),
      logger: () => {},
    }));
  } catch (error) {
    if (error instanceof PortError && error.code === "config_invalid") {
      throw new Error(`config_invalid: ${error.message}`);
    }
    throw error;
  }

  const producerDataDir = join(ctx.vaultPath, ".kizuki", "producer", MODEL_PRODUCER_ID);
  mkdirSync(producerDataDir, { recursive: true, mode: 0o700 });
  const producer = createModelProducerPort(
    {
      vault_path: ctx.vaultPath,
      data_dir: producerDataDir,
      config: {},
      secrets: (ref) => resolveModelSecret(env, ref),
      clock: () => new Date().toISOString(),
      logger: () => {},
    },
    { llm },
  );

  return {
    hooks: { model_ref: llm.model_ref, producer, claims: { db: ctx.db } },
    async close(): Promise<void> {
      await producer.close();
      await llm.close();
    },
  };
}

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
        const wiring = resolveModelWiring(ctx, io.env);
        let receipt;
        try {
          receipt = await runRail(ctx.db, ctx.vaultPath, rail, {
            ...(wiring === null ? {} : { hooks: wiring.hooks }),
            ...(crashAfter !== undefined && isCrashPoint(crashAfter)
              ? { crashAfter }
              : {}),
          });
        } finally {
          if (wiring !== null) await wiring.close();
        }
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
      const wiring = resolveModelWiring(ctx, io.env);
      let result;
      try {
        result = await runServeDaemon(ctx.db, ctx.vaultPath, {
          once: parsed.flags.has("--once"),
          http: !parsed.flags.has("--no-http"),
          ...(port === undefined ? {} : { port }),
          ...(wiring === null ? {} : { hooks: wiring.hooks }),
          ...(crashAfter !== undefined && isCrashPoint(crashAfter)
            ? { crashAfter }
            : {}),
          process: thisProcess(),
        });
      } finally {
        if (wiring !== null) await wiring.close();
      }
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
