import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join, resolve } from "node:path";
import { readServeIntent, writeServeIntent } from "../packages/core/src/serve/intent";
import { loadServeConfig } from "../packages/core/src/serve/config";
import { renderLaunchdPlist, renderSystemdUnit } from "../packages/core/src/serve/units";
import { collectEngineProcess, mcpObservationFromOutput, parseDoctorObservation } from "./artifact-engine";
import { installServeService, realSupervisorHost } from "../packages/core/src/serve/supervisor";
import { HEARTBEAT_SECONDS, LEASE_RECLAIM_HEARTBEATS } from "../packages/core/src/serve/types";
import { parseBuildInfo, parseProofArgs } from "./stranger-proof";
import { packageFiles, requireRegularFile, verifyPackageDirectory } from "./release-artifacts";
import { releaseTarget, requireNativeHost } from "./release-targets";
import { installedRailsHealth, readNativeRailDiagnostics, recordInstalledHealth, waitForFreshRails } from "./native-service-health";
import { captureSyntheticServiceTrace } from "./native-service-trace";
import { prepareLaunchctlDiagnostics, projectLaunchctlResult, syntheticServiceFileMetadata } from "./native-launchctl-diagnostics";

import type { CliEngineObservation, McpEngineObservation } from "./artifact-proof";
import { MODEL_PHASE_IDS, runNativeModelMatrix, readStrictNativeQuery, type NativeModelPhase } from "./native-model-matrix";
import { HISTORICAL_RECOVERY_INPUTS, NATIVE_RECOVERY_PHASE_IDS, runNativeRecoveryFixtures, inspectRecoveryFixture, type NativeRecoveryResult } from "./native-recovery-fixtures";

export const BASELINE_SOURCE_SHA = "5d4c9870797607e22d25e30bdda37a879aba9d69";
export const NATIVE_STATE_PHASE_IDS = ["init-no-service", "state-missing", "state-disabled", "state-failed", "state-masked"] as const;
export const NATIVE_LIFECYCLE_PHASE_IDS = [...NATIVE_STATE_PHASE_IDS, "cross-binary-upgrade", ...NATIVE_RECOVERY_PHASE_IDS, ...MODEL_PHASE_IDS] as const;
export const NATIVE_LIFECYCLE_REGISTRY = {
  schema: "kizuki.native-lifecycle-fixtures/v1", baseline_source_sha: BASELINE_SOURCE_SHA,
  recovery: HISTORICAL_RECOVERY_INPUTS, phase_ids: NATIVE_LIFECYCLE_PHASE_IDS,
} as const;
export const NATIVE_LIFECYCLE_REGISTRY_SHA256 = createHash("sha256").update(JSON.stringify(NATIVE_LIFECYCLE_REGISTRY)).digest("hex");
export type NativeStateEvidence = {
  mechanism: "systemd" | "launchd" | "not-applicable-launchd"; unit: string;
  unit_state: string; manager_exit: number; manager_pid: number | null; definition_exists: boolean;
  intent: string; public_supervisor_state: string; public_enabled: boolean; public_detail: string; public_doctor_ok: boolean;
  observed_failure: string | null; process_absent: boolean; definition_sha256: string | null;
};
export type NativeStatePhase = { id: typeof NATIVE_STATE_PHASE_IDS[number]; passed: boolean; evidence: NativeStateEvidence };
export type NativeUpgradeEvidence = {
  baseline_source_sha: string; candidate_source_sha: string; baseline_binary_sha256: string; candidate_binary_sha256: string;
  baseline_schema: number; candidate_schema: number; baseline_instance_id: string; candidate_instance_id: string;
  baseline_pid: number; candidate_pid: number; unit: string; vault_id: string; before_event_sha256: string; after_event_sha256: string;
  baseline_stopped: boolean; candidate_active: boolean; baseline_query_preserved: boolean; candidate_query_preserved: boolean;
  backup_verified: boolean; backup_manifest_sha256: string; unit_sha256: string;
};
export type NativeUpgradePhase = { id: "cross-binary-upgrade"; passed: boolean; evidence: NativeUpgradeEvidence };
export type NativeBaselineEvidence = { source_sha: string; target: string; bun_version: string; package_sha256: Record<string, string>;
  runtime: { kizuki: CliEngineObservation; kizuki_mcp: McpEngineObservation } };
export type NativeRecoveryServiceEvidence = { id: NativeRecoveryResult["service_vaults"][number]["id"]; vault_id: string; unit: string;
  pid: number; instance_id: string; ledger_schema: number; active: boolean; stopped: boolean; event_text_sha256: string };
export type NativeLifecycleQualification = { registry_sha256: string; baseline: NativeBaselineEvidence | null;
  phases: (NativeStatePhase | NativeUpgradePhase | NativeModelPhase | NativeRecoveryResult["phases"][number])[];
  recovery_services: NativeRecoveryServiceEvidence[] };

const repository = resolve(import.meta.dir, "..");
const timeout = 30_000;
const restartTimeout = (HEARTBEAT_SECONDS * LEASE_RECLAIM_HEARTBEATS + 15) * 1000;
type CommandResult = { exit_code: number; stdout: string; stderr: string };
type Observation = { manager_pid: number | null; marker_pid: number | null; instance_id: string | null; command: string | null };
type Step = { id: string; passed: boolean; evidence: unknown };

function hash(path: string): string {
  requireRegularFile(path);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
function text(value: Uint8Array): string {
  const decoded = Buffer.from(value).toString("utf8");
  return decoded.length > 8192 ? decoded.slice(0, 8192) + "[truncated]" : decoded;
}
function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  check(result.exitCode === 0, "source Git identity unavailable");
  return result.stdout.toString().trim();
}

/** Capture the actual synthetic command failure before the controller cleans
 * the unit. Successful command results retain the existing closed shape. */
export function runNativeExtensionCommand(command: readonly string[], cwd: string, env: Record<string, string>, expectedExit: number,
  failed: (evidence: { command: string[]; expected_exit: number; exit_code: number; signal: string | null; duration_ms: number; stdout: string; stderr: string }) => void,
  timeoutMs = timeout): CommandResult {
  check(command.length > 0 && command.length <= 17 && command.every(part => part.length <= 4096), "extension command argument bound");
  const started = performance.now();
  const raw = Bun.spawnSync([...command], { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
  const result = { exit_code: raw.exitCode, stdout: text(raw.stdout), stderr: text(raw.stderr) };
  if (raw.exitCode !== expectedExit || raw.signalCode !== undefined) {
    failed({ command: [...command], expected_exit: expectedExit, ...result, signal: raw.signalCode ?? null, duration_ms: Math.ceil(performance.now() - started) });
    throw new Error(`extension command failed: ${command[1] ?? "unknown"}`);
  }
  return result;
}

/** Only automatic supervisor restarts wait through the lease reclaim window. */
export function nativeWaitTimeout(description: string): number {
  return description === "crash-restarts-new-instance" || description === "launchd-restarts-after-graceful-exit"
    ? restartTimeout : timeout;
}

/** Failure evidence is collected before cleanup and cannot replace the timeout. */
export async function waitForNativeState(
  predicate: () => boolean, description: string, onTimeout: () => void, timeoutMs = nativeWaitTimeout(description),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(200); }
  try { onTimeout(); } catch { /* Diagnostic failure must not hide the failed lifecycle gate. */ }
  throw new Error(`timed out: ${description}`);
}

/** Parses only anchored native manager fields; an incidental PID is not activity evidence. */
export function managerPid(platform: string, result: CommandResult): number | null {
  if (result.exit_code !== 0 || (platform !== "darwin" && platform !== "linux")) return null;
  if (platform === "darwin" && !/^\s*state = running\s*$/m.test(result.stdout)) return null;
  if (platform === "linux" && !/^ActiveState=active$/m.test(result.stdout)) return null;
  const match = (platform === "darwin" ? /^\s*pid = ([1-9]\d*)\s*$/m : /^MainPID=([1-9]\d*)$/m).exec(result.stdout);
  const pid = Number(match?.[1]);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/** Missing definitions do not imply stopped processes; query failure never proves cleanup. */
export function nativeServiceStopped(platform: string, result: CommandResult): boolean {
  if (platform === "darwin") return result.exit_code !== 0 && /could not find service/i.test(result.stdout + result.stderr);
  return platform === "linux" && result.exit_code === 0 && /^MainPID=0$/m.test(result.stdout) &&
    /^ActiveState=(inactive|failed)$/m.test(result.stdout);
}

export type OwnedNativeFixtureUnit = { vault: string; unit: string; unitPath: string; executable: string };
export type NativeFixtureCleanupRow = { unit: string; service_gone: boolean; unit_removed: boolean };

/** Every owned unit is attempted independently. An unknown service retains its
 * definition and the complete synthetic root, even if other units are gone. */
export async function cleanupOwnedNativeFixtures(platform: string, fixtureRoot: string | null,
  units: readonly OwnedNativeFixtureUnit[], host: {
    attemptStop(unit: OwnedNativeFixtureUnit): void;
    state(unit: OwnedNativeFixtureUnit): CommandResult;
    reload(): void;
    record(row: NativeFixtureCleanupRow): void;
  }, timeoutMs = timeout) {
  const rows: NativeFixtureCleanupRow[] = [], errors: string[] = [];
  for (const owned of [...units].reverse()) {
    let gone = false;
    try {
      host.attemptStop(owned);
      let state = host.state(owned); const deadline = Date.now() + timeoutMs;
      while (!nativeServiceStopped(platform, state) && Date.now() < deadline) { await Bun.sleep(100); state = host.state(owned); }
      gone = nativeServiceStopped(platform, state) && !existsSync(join(owned.vault, ".kizuki/serve.pid"));
      if (gone && existsSync(owned.unitPath)) unlinkSync(owned.unitPath);
    } catch (error) { errors.push(`${owned.unit}: ${error instanceof Error ? error.message : "cleanup failed"}`); }
    const row = { unit: owned.unit, service_gone: gone, unit_removed: !existsSync(owned.unitPath) };
    rows.push(row);
    try { host.record(row); } catch (error) { errors.push(`${owned.unit}: ${error instanceof Error ? error.message : "cleanup receipt failed"}`); }
  }
  try { if (units.length > 0) host.reload(); }
  catch (error) { errors.push(error instanceof Error ? error.message : "cleanup manager reload failed"); }
  const service_gone = rows.every(row => row.service_gone), unit_removed = rows.every(row => row.unit_removed);
  let synthetic_root_removed = false;
  if (service_gone && unit_removed && errors.length === 0 && fixtureRoot) {
    try { rmSync(fixtureRoot, { recursive: true }); synthetic_root_removed = true; }
    catch (error) { errors.push(error instanceof Error ? error.message : "synthetic root removal failed"); }
  }
  return { service_gone, unit_removed, synthetic_root_removed, units: rows, errors };
}

export function parseLifecycleArgs(argv: readonly string[]) {
  const rest: string[] = []; let baseline: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--baseline-artifact") { rest.push(argv[i]!); continue; }
    const value = argv[++i];
    check(baseline === null && value !== undefined && !value.startsWith("--"), "invalid --baseline-artifact");
    baseline = resolve(value);
  }
  return { ...parseProofArgs(rest), baseline_artifact: baseline };
}

export function statePhasePassed(id: NativeStatePhase["id"], e: NativeStateEvidence): boolean {
  if (id === "state-masked" && e.mechanism === "not-applicable-launchd") return e.unit_state === "not-applicable" && e.process_absent;
  if (!e.process_absent || e.manager_pid !== null) return false;
  if (id === "init-no-service") return !e.definition_exists && e.intent === "opted-out" && e.public_supervisor_state === "absent" && !e.public_enabled && e.public_doctor_ok;
  if (id === "state-missing") return !e.definition_exists && e.intent === "installed" && e.public_supervisor_state === "absent" && !e.public_enabled && !e.public_doctor_ok;
  if (id === "state-disabled") return e.definition_exists && e.intent === "installed" && !e.public_enabled && !e.public_doctor_ok && ["absent","disabled"].includes(e.public_supervisor_state);
  if (id === "state-failed") return e.definition_exists && e.intent === "installed" && e.observed_failure !== null && e.public_enabled && !e.public_doctor_ok && e.public_supervisor_state === "disabled" && /^failed(?: \(last exit code [1-9][0-9]*\))?$/.test(e.public_detail);
  return e.unit_state === "masked" && e.public_supervisor_state === "masked" && !e.public_enabled && !e.public_doctor_ok;
}

export function upgradePhasePassed(e: NativeUpgradeEvidence): boolean {
  return e.baseline_source_sha === BASELINE_SOURCE_SHA && e.candidate_source_sha !== BASELINE_SOURCE_SHA &&
    e.baseline_binary_sha256 !== e.candidate_binary_sha256 && e.baseline_instance_id !== e.candidate_instance_id &&
    e.baseline_pid > 1 && e.candidate_pid > 1 && e.baseline_schema === 21 && e.candidate_schema === 21 &&
    e.before_event_sha256 === e.after_event_sha256 && e.baseline_stopped && e.candidate_active &&
    e.baseline_query_preserved && e.candidate_query_preserved && e.backup_verified;
}

/** Real native CI only: this harness owns explicitly registered synthetic user services. */
export async function runNativeServiceLifecycle(argv: readonly string[]): Promise<string> {
  const args = parseLifecycleArgs(argv);
  mkdirSync(args.report, { recursive: true, mode: 0o700 });
  const receiptPath = join(args.report, "receipt.json");
  check(!existsSync(receiptPath), "refusing to replace a lifecycle receipt");
  const steps: Step[] = [];
  const failures: string[] = [];
  const receipt = {
    schema: "kizuki.native-service-lifecycle/v2", source_sha: "unavailable", target: "unavailable",
    host: { platform: process.platform, arch: process.arch, kernel: release(), bun: Bun.version, uid: process.getuid?.() ?? null },
    binary_sha256: "unavailable", package_sha256: {} as Record<string, string>, steps, failures,
    scope: { native_user_service: true, synthetic_vault_only: true, release_upgrade: false, migration_rollback: true, configured_model: true,
      cross_binary_fixture_upgrade: true, historical_migration: true, configured_synthetic_model: true, dependency_offline_startup: true, hardware_reboot: false, host_network_isolation: false },
    qualification: { registry_sha256: NATIVE_LIFECYCLE_REGISTRY_SHA256, baseline: null, phases: [], recovery_services: [] } as NativeLifecycleQualification,
    passed: false, cleanup: { attempted: false, service_gone: false, unit_removed: false, synthetic_root_removed: false,
      units: [] as { unit: string; service_gone: boolean; unit_removed: boolean }[] },
  };
  const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  const record = (id: string, passed: boolean, evidence: unknown) => { steps.push({ id, passed, evidence }); save(); check(passed, `${id} failed`); };
  let fixtureRoot: string | null = null;
  let vault = "", unit = "", unitPath = "", executable = "";
  let cliEnv: Record<string, string> = {};
  let startupCapture: ReturnType<typeof prepareLaunchctlDiagnostics>["startup_capture"] = null;
  const ownedUnits: OwnedNativeFixtureUnit[] = [];
  const rememberUnit = () => {
    const prior = ownedUnits.find(row => row.unit === unit);
    if (prior) prior.executable = executable;
    else if (unit) ownedUnits.push({ vault, unit, unitPath, executable });
  };
  const platform = process.platform;
  const manager = platform === "darwin" ? "/bin/launchctl" : "/usr/bin/systemctl";
  const managerEnv: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir(), LANG: "C.UTF-8" };
  for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (process.env[key]) managerEnv[key] = process.env[key]!;
  }
  const invoke = (command: readonly string[], env = cliEnv, commandTimeout = timeout): CommandResult => {
    const result = Bun.spawnSync([...command], { cwd: fixtureRoot ?? repository, env, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: commandTimeout });
    return { exit_code: result.exitCode, stdout: text(result.stdout), stderr: text(result.stderr) };
  };
  const native = (...command: string[]) => invoke([manager, ...command], managerEnv);
  const cli = (id: string, command: string[], expectedExit = 0, binary = executable) => {
    const result = invoke([binary, ...command]);
    record(id, result.exit_code === expectedExit, { command: ["kizuki", ...command], ...result });
    return result;
  };
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const managerState = (commandTimeout = timeout) => invoke(platform === "darwin" ? [manager, "print", `${domain}/${unit}`] :
    [manager, "--user", "show", unit, "--property=MainPID,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,LoadState,UnitFileState,NRestarts"], managerEnv, commandTimeout);
  const processObservation = (state = managerState(), commandTimeout = timeout): Observation => {
    let marker: { pid?: number; instance_id?: string } = {};
    try { marker = JSON.parse(readFileSync(join(vault, ".kizuki", "serve.pid"), "utf8")); } catch { /* A marker is absent while stopped. */ }
    const pid = managerPid(platform, state);
    const command = pid === null ? null : invoke(["/bin/ps", "-p", String(pid), "-o", "command="], managerEnv, commandTimeout).stdout.trim();
    return { manager_pid: pid, marker_pid: marker.pid ?? null, instance_id: marker.instance_id ?? null, command };
  };
  const waitFor = (predicate: () => boolean, description: string) => waitForNativeState(predicate, description, () => {
    const evidence: Record<string, unknown> = { waiting_for: description, unit };
    try {
      const state = managerState(5000);
      evidence.manager_state = platform === "darwin" ? projectLaunchctlResult("print", { ...state, signal: null }, 0) : state;
      evidence.process_observation = processObservation(state, 5000);
    } catch { evidence.process_diagnostics_error = "native state or process query failed"; }
    if (platform === "linux") {
      // The generated unit is unique to this synthetic clean-environment vault.
      // Never retrieve an unfiltered user journal or the manager environment.
      const command = ["/usr/bin/journalctl", `--user-unit=${unit}`, "--boot", "--lines=80", "--no-pager", "--output=short-iso"];
      try { evidence.unit_journal = { command, ...invoke(command, managerEnv, 5000) }; }
      catch { evidence.journal_diagnostics_error = "owned unit journal query failed"; }
    }
    steps.push({ id: "native-wait-timeout-diagnostics", passed: false, evidence });
    save();
  });
  const active = async (id: string, binary: string, previous: Observation | null = null) => {
    let observed: Observation = { manager_pid: null, marker_pid: null, instance_id: null, command: null };
    await waitFor(() => {
      observed = processObservation();
      return observed.manager_pid !== null && observed.manager_pid === observed.marker_pid &&
        observed.command?.includes(binary) === true && observed.command.includes(vault) &&
        observed.instance_id !== null && (previous === null || observed.instance_id !== previous.instance_id);
    }, id);
    record(id, true, observed);
    return observed;
  };
  const signalOwned = (observed: Observation, signal: "SIGKILL" | "SIGTERM") => {
    const current = processObservation();
    check(current.manager_pid !== null && current.manager_pid === observed.manager_pid && current.marker_pid === current.manager_pid &&
      current.instance_id === observed.instance_id && current.command?.includes(vault), "refusing to signal an unverified service process");
    process.kill(current.manager_pid, signal);
  };
  save();
  try {
    check(process.env.GITHUB_ACTIONS === "true" && process.env.CI === "true", "native service proof requires an ephemeral GitHub Actions runner");
    check((platform === "darwin" && process.arch === "arm64") || (platform === "linux" && process.arch === "x64"), "unsupported native lifecycle host");
    check((process.getuid?.() ?? 0) !== 0, "native service proof must run as a non-root user");
    check(Bun.version === "1.3.14", "native service proof requires Bun 1.3.14");
    const sourceSha = git(["rev-parse", "HEAD"]);
    const exact = () => check(git(["rev-parse", "HEAD"]) === sourceSha && git(["status", "--porcelain"]) === "", "lifecycle source changed");
    exact();
    receipt.source_sha = sourceSha;
    requireRegularFile(join(args.artifact, "BUILD.json"));
    const build = parseBuildInfo(join(args.artifact, "BUILD.json"));
    verifyPackageDirectory(args.artifact, build);
    const names = packageFiles(build);
    requireNativeHost(releaseTarget(build.target));
    check(build.source_sha === sourceSha && build.bun_version === Bun.version, "package is not the exact native source candidate");
    receipt.target = build.target;
    check(args.baseline_artifact !== null, "native lifecycle requires --baseline-artifact");
    const baselineBuild = parseBuildInfo(join(args.baseline_artifact, "BUILD.json"));
    verifyPackageDirectory(args.baseline_artifact, baselineBuild);
    check(build.schema === "kizuki.release-build/v2" && baselineBuild.schema === "kizuki.release-build/v2" && baselineBuild.source_sha === BASELINE_SOURCE_SHA && baselineBuild.target === build.target && baselineBuild.bun_version === build.bun_version,
      "baseline package identity mismatch");
    check(hash(join(args.baseline_artifact, "kizuki")) !== hash(join(args.artifact, "kizuki")), "baseline must be a distinct compiled binary");
    check(process.env.RUNNER_TEMP, "native lifecycle proof requires the runner temporary directory");
    // A systemd PrivateTmp service cannot see a fixture placed under /tmp.
    fixtureRoot = realpathSync(mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), "kizuki native lifecycle ")));
    const home = join(fixtureRoot, "home");
    mkdirSync(home, { mode: 0o700 });
    const copied = join(fixtureRoot, "installed package");
    cpSync(args.artifact, copied, { recursive: true, dereference: false, errorOnExist: true });
    verifyPackageDirectory(copied, build);
    executable = join(copied, "kizuki");
    for (const name of names) {
      receipt.package_sha256[name] = hash(join(copied, name));
      check(receipt.package_sha256[name] === hash(join(args.artifact, name)), "copied package identity changed");
    }
    receipt.binary_sha256 = hash(executable);
    const configHome = platform === "linux" ? (process.env.XDG_CONFIG_HOME || join(homedir(), ".config")) : join(home, ".config");
    mkdirSync(configHome, { recursive: true, mode: 0o700 });
    cliEnv = { ...managerEnv, HOME: home, XDG_CONFIG_HOME: configHome, KIZUKI_CONFIG: join(home, "kizuki.toml") };
    // No API keys, credential paths, model endpoint, or user configuration is inherited.
    const available = platform === "darwin" ? native("print", domain) : native("--user", "show", "--property=Version");
    // Only service-manager reachability is needed; no manager environment is read.
    record("native-user-manager-available", available.exit_code === 0, { command: platform === "darwin" ? "launchctl print gui/<uid>" : "systemctl --user show --property=Version", exit_code: available.exit_code });
    vault = join(fixtureRoot, "synthetic vault");
    const serviceDiagnostics = (name: string) => {
      if (platform !== "linux") return null;
      const queries = [
        ["--user", "show", name, "--property=LoadState,ActiveState,UnitFileState,MainPID"],
        ["--user", "is-enabled", name],
        ["--user", "is-active", name],
      ];
      return { unit: name, paths: { home, xdg_config_home: configHome, manager_home: managerEnv.HOME,
        xdg_runtime_dir: managerEnv.XDG_RUNTIME_DIR ?? null },
        queries: queries.map(command => ({ command: [manager, ...command], ...native(...command) })) };
    };
    if (platform === "linux") {
      // Init chooses its own fresh vault identity. Probe a distinct never-installed
      // synthetic unit before init; then capture the actual identity after init.
      record("pre-init-absent-unit-diagnostics", true, serviceDiagnostics(`kizuki@lifecycle-probe-${crypto.randomUUID()}.service`));
    }
    // Default init must create and activate the installed service, without --no-service.
    // Default qualification keeps startup timing uninstrumented. Explicit CI
    // diagnosis can opt in without changing any product configuration.
    const initialDiagnostic = platform === "darwin" && process.env.KIZUKI_NATIVE_INITIAL_DIAGNOSTICS === "1"
      ? prepareLaunchctlDiagnostics(fixtureRoot) : null;
    const instrumentedEnv = initialDiagnostic === null ? cliEnv : { ...cliEnv,
      PATH: `${initialDiagnostic.path}:${cliEnv.PATH}`, CI: "true", GITHUB_ACTIONS: "true",
      RUNNER_TEMP: realpathSync(process.env.RUNNER_TEMP!) };
    const initializedAt = new Date().toISOString();
    const initialized = invoke([executable, "init", vault, "--no-default"], instrumentedEnv);
    const initialRows = initialDiagnostic?.collect().rows.length ?? 0;
    if (existsSync(join(vault, ".kizuki", "vault-id"))) {
      const vaultId = readFileSync(join(vault, ".kizuki", "vault-id"), "utf8").trim();
      check(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(vaultId), "invalid synthetic vault identity");
      unit = platform === "darwin" ? `dev.kizuki.${vaultId}` : `kizuki@${vaultId}.service`;
      unitPath = platform === "darwin" ? join(home, "Library/LaunchAgents", `${unit}.plist`) : join(configHome, "systemd/user", unit);
      rememberUnit();
    }
    if (initialDiagnostic !== null) {
      steps.push({ id: "instrumented-default-init-diagnostics", passed: initialRows > 0,
        evidence: { ...initialDiagnostic.collect(), expected_wrapper_sha256: initialDiagnostic.wrapper_sha256 } });
      save();
    }
    record("default-init-installs-service", initialized.exit_code === 0, { ...initialized,
      instrumented: initialDiagnostic !== null, timing_changed: initialDiagnostic !== null,
      native_status: unit ? serviceDiagnostics(unit) : null });
    let observed = await active("default-init-running", executable);
    const status = invoke([executable, "serve", "status", "--json", "--vault", vault]);
    const statusBody = JSON.parse(status.stdout).data;
    record("public-status-agrees-with-native-manager", statusBody?.pid === observed.manager_pid && statusBody?.supervisor?.state === "active" &&
      statusBody?.supervisor?.enabled === true, status);
    const diagnostics = await waitForFreshRails(() => readNativeRailDiagnostics(vault,
      { pid: observed.manager_pid!, instance_id: observed.instance_id! }, initializedAt));
    const freshStatus = invoke([executable, "serve", "status", "--json", "--vault", vault]);
    const installedHealth = installedRailsHealth(freshStatus, diagnostics, initializedAt);
    recordInstalledHealth(steps, failures, installedHealth);
    save();
    if (platform === "linux" && !installedHealth.passed) {
      const current = processObservation();
      const verified = current.manager_pid === observed.manager_pid && current.marker_pid === current.manager_pid &&
        current.instance_id === observed.instance_id && current.command === observed.command;
      const evidence = verified ? captureSyntheticServiceTrace({ fixtureRoot, vault, binary: executable,
        pid: current.manager_pid!, instanceId: current.instance_id! }) : { status: "target_changed" };
      steps.push({ id: "failed-rail-syscall-diagnostics", passed: evidence.status === "captured", evidence });
      save();
    }

    record("private-unit", (lstatSync(unitPath).mode & 0o777) === 0o600, { unit, mode: lstatSync(unitPath).mode & 0o777, sha256: hash(unitPath) });
    // Port zero avoids a fixed port when the unique service is subsequently restarted.
    writeFileSync(join(vault, ".kizuki", "serve.toml"), "[serve]\nbind_port = 0\n", { mode: 0o600 });
    if (platform === "darwin") {
      const vaultId = readFileSync(join(vault, ".kizuki/vault-id"), "utf8").trim();
      const captureStartup = process.env.KIZUKI_NATIVE_MAC_STARTUP_CAPTURE === "1";
      check(!captureStartup || initialDiagnostic === null, "startup capture requires uninstrumented initial init");
      const diagnostic = initialDiagnostic ?? prepareLaunchctlDiagnostics(fixtureRoot, vaultId, captureStartup);
      startupCapture = diagnostic.startup_capture;
      if (captureStartup) {
        failures.push("diagnostic startup capture is ineligible for lifecycle qualification");
        steps.push({ id: "mac-startup-capture-enabled", passed: false, evidence: {
          changed_native_configuration: true, timing_changed: true, release_eligible: false } });
        save();
      }
      // Only this CLI child sees the wrapper. launchd's unit contains no inherited
      // EnvironmentVariables, and the parent/native observer environment is unchanged.
      const env = { ...cliEnv, PATH: `${diagnostic.path}:${cliEnv.PATH}`, CI: "true", GITHUB_ACTIONS: "true",
        RUNNER_TEMP: realpathSync(process.env.RUNNER_TEMP!) };
      const before = syntheticServiceFileMetadata(fixtureRoot, vaultId);
      const result = invoke([executable, "serve", "--install", "--json", "--vault", vault], env);
      const collected = diagnostic.collect();
      const trace = { ...collected, rows: collected.rows.slice(initialRows) };
      const state = managerState(5000);
      steps.push({ id: "instrumented-repeat-install-diagnostics", passed: trace.rows.length > 0,
        evidence: { ...trace, expected_wrapper_sha256: diagnostic.wrapper_sha256, before,
          after: syntheticServiceFileMetadata(fixtureRoot, vaultId),
          manager: projectLaunchctlResult("print", { ...state, signal: null }, 0),
          process: processObservation(state, 5000) } });
      save();
      record("repeat-install", result.exit_code === 0, { ...result, instrumented: true, timing_changed: true });
      check(trace.rows.length > 0 && trace.wrapper_sha256 === diagnostic.wrapper_sha256,
        "packaged supervisor did not produce the expected launchctl trace");
      observed = await active("repeat-install-replaces-process", executable, observed);
      // A successful instrumented run is followed by an independent uninstrumented
      // replacement. Either failure stays a failure; neither operation is retried.
      cli("uninstrumented-repeat-install", ["serve", "--install", "--json", "--vault", vault]);
      observed = await active("repeat-install-replaces-process", executable, observed);
    } else {
      cli("repeat-install", ["serve", "--install", "--json", "--vault", vault]);
      observed = await active("repeat-install-replaces-process", executable, observed);
    }
    signalOwned(observed, "SIGKILL");
    observed = await active("crash-restarts-new-instance", executable, observed);
    cli("public-graceful-stop", ["serve", "stop", "--vault", vault]);
    if (platform === "darwin") {
      // launchd KeepAlive=true restarts even a clean exit; this is process-stop proof.
      observed = await active("launchd-restarts-after-graceful-exit", executable, observed);
      const stopped = managerState();
      record("launchd-graceful-exit", /^\s*last exit code = 0\s*$/m.test(stopped.stdout),
        projectLaunchctlResult("print", { ...stopped, signal: null }, 0));
    } else {
      await waitFor(() => nativeServiceStopped(platform, managerState()) && !existsSync(join(vault, ".kizuki", "serve.pid")), "graceful process stop");
      const stopped = managerState();
      record("systemd-graceful-exit", /^ExecMainStatus=0$/m.test(stopped.stdout), stopped);
    }
    cli("uninstall-before-stopped-read", ["serve", "--uninstall", "--json", "--vault", vault]);
    await waitFor(() => nativeServiceStopped(platform, managerState()) && !existsSync(join(vault, ".kizuki", "serve.pid")), "uninstall stops service");
    record("deliberately-stopped", !existsSync(unitPath), { unit_exists: existsSync(unitPath), intent: readFileSync(join(vault, ".kizuki", "serve-intent"), "utf8").trim() });
    const notes = join(fixtureRoot, "notes"); mkdirSync(notes, { mode: 0o700 });
    writeFileSync(join(notes, "welcome.md"), "Ada met Grace at the lifecycle observatory.\n", { mode: 0o600 });
    const policy = join(fixtureRoot, "source-policy.json");
    writeFileSync(policy, JSON.stringify({ purposes: ["capture", "recall", "session", "derive", "export"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" }), { mode: 0o600 });
    cli("stopped-import", ["import", "markdown-folder", "--source", notes, "--policy", policy, "--expected-revision", "0", "--operation-id", "native-lifecycle-import", "--vault", vault]);
    const query = () => invoke([executable, "query", "Ada", "--degraded", "--vault", vault]);
    let result = query();
    record("stopped-evidence-readable", result.exit_code === 0 && result.stdout.includes("observatory"), result);
    const upgraded = join(fixtureRoot, "replacement package");
    cpSync(copied, upgraded, { recursive: true, errorOnExist: true });
    verifyPackageDirectory(upgraded, build);
    const replacement = join(upgraded, "kizuki");
    check(hash(replacement) === receipt.binary_sha256, "replacement executable identity changed");
    cli("replacement-location-install", ["serve", "--install", "--json", "--vault", vault], 0, replacement);
    observed = await active("replacement-executable-running", replacement);
    const previousUnit = readFileSync(unitPath, "utf8");
    const previousUnitHash = hash(unitPath);
    const host = realSupervisorHost(platform === "darwin" ? "launchd" : "systemd", home,
      [join(fixtureRoot, "absent-executable"), "serve", "--vault", vault], { configHome });
    let failure: string | null = null;
    try { installServeService(vault, host); } catch (error) { failure = error instanceof Error ? error.message : "service change rejected"; }
    record("native-api-failed-activation-rolls-back", failure !== null && hash(unitPath) === previousUnitHash &&
      readFileSync(unitPath, "utf8") === previousUnit && !existsSync(join(vault, ".kizuki", "service-change.json")),
      { failure, unit_sha256: hash(unitPath), recovery_journal_exists: existsSync(join(vault, ".kizuki", "service-change.json")), boundary: "exact-source native API with missing executable; not a packaged release migration" });
    await active("rollback-restores-replacement-process", replacement, observed);
    cli("final-uninstall", ["serve", "--uninstall", "--json", "--vault", vault], 0, replacement);
    await waitFor(() => nativeServiceStopped(platform, managerState()) && !existsSync(join(vault, ".kizuki", "serve.pid")), "final uninstall stop");
    result = query();
    record("uninstall-preserves-readable-vault", result.exit_code === 0 && result.stdout.includes("observatory") && !existsSync(unitPath), result);
    const exportPath = join(fixtureRoot, "export"), restored = join(fixtureRoot, "restored");
    cli("export-stopped-vault", ["export", "--out", exportPath, "--vault", vault]);
    cli("verify-recovery-export", ["restore", "--from", exportPath, "--verify"]);
    cli("restore-stopped-vault", ["restore", "--from", exportPath, "--into", restored]);
    const restoredQuery = invoke([executable, "query", "Ada", "--degraded", "--vault", restored]);
    record("recovered-evidence-readable", restoredQuery.exit_code === 0 && restoredQuery.stdout.includes("observatory"), restoredQuery);
    const qualification = receipt.qualification;
    const recordPhase = (phase: NativeLifecycleQualification["phases"][number]) => {
      check(!qualification.phases.some(row => row.id === phase.id), "duplicate native phase");
      qualification.phases.push(phase);
      if (!phase.passed) failures.push(`${phase.id} failed`);
      save();
    };
    const selectVault = (selected: string, binary = executable) => {
      vault = selected; executable = binary;
      const id = readFileSync(join(vault, ".kizuki/vault-id"), "utf8").trim();
      check(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id), "invalid extension vault identity");
      unit = platform === "darwin" ? `dev.kizuki.${id}` : `kizuki@${id}.service`;
      unitPath = platform === "darwin" ? join(home, "Library/LaunchAgents", `${unit}.plist`) : join(configHome, "systemd/user", unit);
      rememberUnit();
      return id;
    };
    const command = (binary: string, args: string[], expected = 0) => runNativeExtensionCommand([binary, ...args], fixtureRoot!, cliEnv, expected, result => {
      const evidence: Record<string, unknown> = { ...result, unit };
      try {
        const state = managerState(5000);
        evidence.manager = platform === "darwin" ? projectLaunchctlResult("print", { ...state, signal: null }, 0) : state;
        evidence.process = processObservation(state, 5000);
      } catch { evidence.manager_diagnostic = "unavailable"; }
      steps.push({ id: "extension-command-failure", passed: false, evidence }); save();
    });
    const candidate = join(copied, "kizuki");
    const activateExtension = async (selected: string, binary = candidate) => {
      selectVault(selected, binary); const started_at = new Date().toISOString();
      command(binary, ["serve", "--install", "--json", "--vault", vault]);
      let current: Observation = { manager_pid: null, marker_pid: null, instance_id: null, command: null };
      await waitFor(() => {
        current = processObservation();
        return current.manager_pid !== null && current.manager_pid === current.marker_pid && current.instance_id !== null &&
          current.command?.includes(binary) === true && current.command.includes(vault);
      }, "extension service activation");
      return { unit, pid: current.manager_pid!, instance_id: current.instance_id!, started_at };
    };
    const deactivateExtension = async (selected: string, binary = candidate) => {
      selectVault(selected, binary);
      command(binary, ["serve", "--uninstall", "--json", "--vault", vault]);
      await waitFor(() => nativeServiceStopped(platform, managerState()) && !existsSync(join(vault, ".kizuki/serve.pid")), "extension service stop");
    };
    const stateEvidence = (mechanism: NativeStateEvidence["mechanism"] = platform === "linux" ? "systemd" : "launchd"): NativeStateEvidence => {
      const state = managerState(), status = invoke([candidate, "serve", "status", "--json", "--vault", vault]);
      const data = JSON.parse(status.stdout).data, supervisor = data?.supervisor;
      check(supervisor && typeof supervisor.state === "string" && typeof supervisor.enabled === "boolean" && typeof supervisor.detail === "string" && typeof data.doctor?.ok === "boolean", "public native state unavailable");
      const failed = platform === "linux" ? /^ActiveState=failed$/m.test(state.stdout) : /^\s*last exit code = [1-9]\d*\s*$/m.test(state.stdout);
      return { mechanism, unit, unit_state: platform === "linux" ? /^ActiveState=(\S+)$/m.exec(state.stdout)?.[1] ?? "unknown" : /^\s*state = ([^\r\n]+)$/m.exec(state.stdout)?.[1]?.trim() ?? "absent",
        manager_exit: state.exit_code, manager_pid: managerPid(platform, state), definition_exists: existsSync(unitPath), intent: readServeIntent(vault),
        public_supervisor_state: supervisor.state, public_enabled: supervisor.enabled, public_detail: supervisor.detail, public_doctor_ok: data.doctor.ok,
        observed_failure: failed ? (platform === "linux" ? /^Result=(\S+)$/m.exec(state.stdout)?.[1] ?? "failed" : /^\s*last exit code = (\d+)\s*$/m.exec(state.stdout)?.[1] ?? "failed") : null,
        process_absent: managerPid(platform, state) === null && !existsSync(join(vault, ".kizuki/serve.pid")),
        definition_sha256: existsSync(unitPath) && !lstatSync(unitPath).isSymbolicLink() ? hash(unitPath) : null };
    };
    const statesVault = join(fixtureRoot, "states vault");
    command(candidate, ["init", statesVault, "--no-service", "--no-default"]); selectVault(statesVault, candidate);
    let state = stateEvidence(); recordPhase({ id: "init-no-service", passed: statePhasePassed("init-no-service", state), evidence: state });
    writeServeIntent(vault, "installed");
    state = stateEvidence(); recordPhase({ id: "state-missing", passed: statePhasePassed("state-missing", state), evidence: state });
    await activateExtension(statesVault);
    const disable = platform === "linux" ? native("--user", "disable", "--now", unit) : native("bootout", `${domain}/${unit}`);
    check(disable.exit_code === 0, "native disable fixture failed");
    await waitFor(() => nativeServiceStopped(platform, managerState()) && !existsSync(join(vault, ".kizuki/serve.pid")), "disabled fixture stop");
    state = stateEvidence(); recordPhase({ id: "state-disabled", passed: statePhasePassed("state-disabled", state), evidence: state });
    const disabledDefinition = readFileSync(unitPath), disabledHash = hash(unitPath);
    if (platform === "linux") {
      const heldPath = join(fixtureRoot, "held disabled unit"); renameSync(unitPath, heldPath);
      let masked = false;
      try {
        check(native("--user", "daemon-reload").exit_code === 0, "mask preflight reload failed");
        const result = native("--user", "mask", unit); masked = result.exit_code === 0;
        check(masked, "native mask failed");
        state = stateEvidence(); state.unit_state = native("--user", "is-enabled", unit).stdout.trim();
        recordPhase({ id: "state-masked", passed: statePhasePassed("state-masked", state), evidence: state });
      } finally {
        if (masked) check(native("--user", "unmask", unit).exit_code === 0, "native unmask failed");
        check(!existsSync(unitPath) && hash(heldPath) === disabledHash, "masked fixture definition changed");
        renameSync(heldPath, unitPath); check(readFileSync(unitPath).equals(disabledDefinition), "restored fixture definition changed");
        check(native("--user", "daemon-reload").exit_code === 0, "unmask reload failed");
      }
    } else {
      state = { ...stateEvidence("not-applicable-launchd"), unit_state: "not-applicable" };
      recordPhase({ id: "state-masked", passed: statePhasePassed("state-masked", state), evidence: state });
    }
    await deactivateExtension(statesVault);

    // A separate unique unit contains the deliberate execution failure. The
    // normal qualification unit never receives a modified restart policy.
    const failedVault = join(fixtureRoot, "failure vault");
    command(candidate, ["init", failedVault, "--no-service", "--no-default"]); const failedId = selectVault(failedVault, candidate);
    writeServeIntent(vault, "installed"); mkdirSync(join(unitPath, ".."), { recursive: true, mode: 0o700 });
    const spec = { vaultPath: vault, vaultId: failedId, execStart: [candidate, "native-fixture-invalid-command", "--vault", vault], config: loadServeConfig(vault) };
    const generated = platform === "linux" ? renderSystemdUnit(spec) : renderLaunchdPlist(spec);
    const failedDefinition = platform === "linux" ? generated.replace("Restart=on-failure", "Restart=no") : generated.replace("<key>KeepAlive</key>\n  <true/>", "<key>KeepAlive</key>\n  <false/>");
    check(failedDefinition !== generated, "failure fixture restart policy unchanged");
    const generatedPreimage = join(fixtureRoot, "failure-unit.generated-preimage");
    writeFileSync(generatedPreimage, generated, { flag: "wx", mode: 0o600 });
    writeFileSync(join(fixtureRoot, "failure-unit.preimage-sha256"), hash(generatedPreimage) + "\n", { flag: "wx", mode: 0o600 });
    writeFileSync(unitPath, failedDefinition, { flag: "wx", mode: 0o600 });
    if (platform === "linux") { check(native("--user", "daemon-reload").exit_code === 0, "failed fixture reload failed"); native("--user", "enable", "--now", unit); }
    else check(native("bootstrap", domain, unitPath).exit_code === 0, "failed fixture bootstrap failed");
    await waitFor(() => {
      const result = managerState();
      return platform === "linux" ? /^ActiveState=failed$/m.test(result.stdout) : /^\s*last exit code = [1-9]\d*\s*$/m.test(result.stdout) && managerPid(platform, result) === null;
    }, "deliberately failed fixture");
    state = stateEvidence(); recordPhase({ id: "state-failed", passed: statePhasePassed("state-failed", state), evidence: state });
    await deactivateExtension(failedVault);
    // Emit the prescribed ordering even though mask observation is collected
    // before the independent failure fixture, to keep one closed phase registry.
    qualification.phases.sort((a,b) => NATIVE_LIFECYCLE_PHASE_IDS.indexOf(a.id) - NATIVE_LIFECYCLE_PHASE_IDS.indexOf(b.id)); save();

    const priorPackage = join(fixtureRoot, "baseline package");
    cpSync(args.baseline_artifact!, priorPackage, { recursive: true, dereference: false, errorOnExist: true });
    verifyPackageDirectory(priorPackage, baselineBuild);
    const priorHashes = Object.fromEntries(packageFiles(baselineBuild).map(name => [name, hash(join(priorPackage, name))]));
    const priorBinary = join(priorPackage, "kizuki"), upgradeVault = join(fixtureRoot, "upgrade vault");
    command(priorBinary, ["init", upgradeVault, "--no-service", "--no-default"]);
    const priorCli = await collectEngineProcess(priorBinary, ["doctor", "--json", "--vault", upgradeVault], fixtureRoot, cliEnv, false);
    const priorMcp = await collectEngineProcess(join(priorPackage, "kizuki-mcp"), ["--vault", upgradeVault, "--owner"], fixtureRoot, cliEnv, true);
    qualification.baseline = { source_sha: baselineBuild.source_sha, target: baselineBuild.target, bun_version: baselineBuild.bun_version, package_sha256: priorHashes,
      runtime: { kizuki: parseDoctorObservation(priorCli.stdout, priorCli.exit_code, priorHashes.kizuki!), kizuki_mcp: mcpObservationFromOutput(priorMcp.stdout, priorHashes["kizuki-mcp"]!) } }; save();
    const priorInstance = await activateExtension(upgradeVault, priorBinary);
    const priorRails = await waitForFreshRails(() => readNativeRailDiagnostics(upgradeVault, priorInstance, priorInstance.started_at));
    check(priorRails.complete && !priorRails.truncated && priorRails.error === null, "baseline initial rail coverage unavailable");
    command(priorBinary, ["import", "markdown-folder", "--source", notes, "--policy", policy, "--expected-revision", "0", "--operation-id", "upgrade-import", "--vault", upgradeVault]);
    const priorQuery = command(priorBinary, ["query", "observatory", "--json", "--vault", upgradeVault]);
    await deactivateExtension(upgradeVault, priorBinary);
    const beforeUpgrade = inspectRecoveryFixture(upgradeVault), recoveryCopy = join(fixtureRoot, "baseline export");
    command(priorBinary, ["export", "--out", recoveryCopy, "--vault", upgradeVault]);
    command(priorBinary, ["restore", "--from", recoveryCopy, "--verify"]);
    command(candidate, ["init", upgradeVault, "--no-service", "--no-default"]);
    const nextInstance = await activateExtension(upgradeVault, candidate);
    const candidateActive = managerPid(platform, managerState()) === nextInstance.pid;
    const installedUnitHash = hash(unitPath);
    const nextQuery = command(candidate, ["query", "observatory", "--json", "--vault", upgradeVault]);
    await deactivateExtension(upgradeVault);
    const afterUpgrade = inspectRecoveryFixture(upgradeVault);
    const upgrade: NativeUpgradeEvidence = { baseline_source_sha: baselineBuild.source_sha, candidate_source_sha: sourceSha,
      baseline_binary_sha256: priorHashes.kizuki!, candidate_binary_sha256: receipt.binary_sha256,
      baseline_schema: beforeUpgrade.summary.schema_version, candidate_schema: afterUpgrade.summary.schema_version,
      baseline_instance_id: priorInstance.instance_id, candidate_instance_id: nextInstance.instance_id, baseline_pid: priorInstance.pid, candidate_pid: nextInstance.pid,
      unit, vault_id: readFileSync(join(upgradeVault, ".kizuki/vault-id"), "utf8").trim(),
      before_event_sha256: createHash("sha256").update(JSON.stringify(beforeUpgrade.tables.events)).digest("hex"), after_event_sha256: createHash("sha256").update(JSON.stringify(afterUpgrade.tables.events)).digest("hex"),
      baseline_stopped: true, candidate_active: candidateActive,
      baseline_query_preserved: readStrictNativeQuery(priorQuery).some(hit => hit.scope === "ledger" && hit.authority === "connector_evidence" && hit.snippet.includes("observatory")), candidate_query_preserved: readStrictNativeQuery(nextQuery).some(hit => hit.scope === "ledger" && hit.authority === "connector_evidence" && hit.snippet.includes("observatory")), backup_verified: true,
      backup_manifest_sha256: hash(join(recoveryCopy, "manifest.json")), unit_sha256: installedUnitHash };
    recordPhase({ id: "cross-binary-upgrade", passed: upgradePhasePassed(upgrade), evidence: upgrade });
    verifyPackageDirectory(args.baseline_artifact!, baselineBuild); verifyPackageDirectory(priorPackage, baselineBuild);
    for (const name of packageFiles(baselineBuild)) check(hash(join(priorPackage, name)) === priorHashes[name] && hash(join(args.baseline_artifact!, name)) === priorHashes[name], "baseline package changed");

    mkdirSync(join(fixtureRoot, "recovery"), { mode: 0o700 });
    const recovery = await runNativeRecoveryFixtures({ executable: candidate, candidate_source_sha: sourceSha, helper_source_sha: sourceSha, workspace: join(fixtureRoot, "recovery") });
    for (const phase of recovery.phases) recordPhase(phase);
    for (const recovered of recovery.service_vaults) {
      const instance = await activateExtension(recovered.vault);
      const active = managerPid(platform, managerState()) === instance.pid, recoveredUnit = unit;
      const vaultId = readFileSync(join(recovered.vault, ".kizuki/vault-id"), "utf8").trim();
      await deactivateExtension(recovered.vault);
      const stoppedSnapshot = inspectRecoveryFixture(recovered.vault), schema = stoppedSnapshot.summary.schema_version;
      const eventHash = createHash("sha256").update(String(stoppedSnapshot.tables.events?.[0]?.text)).digest("hex");
      check(eventHash === recovered.event_text_sha256, "activated recovery fixture changed original event");
      qualification.recovery_services.push({ id: recovered.id, vault_id: vaultId, unit: recoveredUnit, pid: instance.pid, instance_id: instance.instance_id,
        ledger_schema: schema, active, stopped: nativeServiceStopped(platform, managerState()), event_text_sha256: eventHash }); save();
    }
    await runNativeModelMatrix({ executable: candidate, workspace: join(fixtureRoot, "model matrix"), env: cliEnv,
      invoke: args => invoke([candidate, ...args]), activate: selected => activateExtension(selected), deactivate: selected => deactivateExtension(selected),
      stillActive: (selected, instance) => { selectVault(selected); const observed = processObservation(); return observed.manager_pid === instance.pid && observed.marker_pid === instance.pid && observed.instance_id === instance.instance_id; },
      record: recordPhase });
    check(qualification.phases.length === NATIVE_LIFECYCLE_PHASE_IDS.length && qualification.phases.every((row,index) => row.id === NATIVE_LIFECYCLE_PHASE_IDS[index]), "native phase inventory incomplete");

    for (const directory of [args.artifact, copied, upgraded]) {
      verifyPackageDirectory(directory, build);
      for (const name of names) check(hash(join(directory, name)) === receipt.package_sha256[name], "package changed during lifecycle proof");
    }
    exact();
    receipt.passed = failures.length === 0 && steps.every(step => step.passed);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "native lifecycle proof failed");
    if (platform === "darwin" && fixtureRoot && unit.startsWith("dev.kizuki.")) {
      try {
        const state = managerState(5000);
        steps.push({ id: "failed-native-service-metadata", passed: false, evidence: {
          files: syntheticServiceFileMetadata(fixtureRoot, unit.slice("dev.kizuki.".length)),
          manager: projectLaunchctlResult("print", { ...state, signal: null }, 0),
          process: processObservation(state, 5000), boundary: "before cleanup; no journal content or manager environment retained",
        } });
      } catch { steps.push({ id: "failed-native-service-metadata", passed: false, evidence: { status: "unavailable" } }); }
    }
  } finally {
    if (startupCapture !== null) {
      try { steps.push({ id: "mac-startup-output-diagnostics", passed: false, evidence: startupCapture.collect() }); }
      catch { steps.push({ id: "mac-startup-output-diagnostics", passed: false, evidence: { status: "capture_unavailable" } }); }
      finally { startupCapture.close(); receipt.passed = false; save(); }
    }
    receipt.cleanup.attempted = true;
    try {
      rememberUnit();
      const cleaned = await cleanupOwnedNativeFixtures(platform, fixtureRoot, ownedUnits, {
        attemptStop: owned => {
          vault = owned.vault; unit = owned.unit; unitPath = owned.unitPath; executable = owned.executable;
          if (executable) invoke([executable, "serve", "--uninstall", "--json", "--vault", vault]);
          if (platform === "darwin") native("bootout", `${domain}/${unit}`);
          else native("--user", "disable", "--now", unit);
        },
        state: () => managerState(5000),
        reload: () => { if (platform === "linux") check(native("--user", "daemon-reload").exit_code === 0, "cleanup manager reload failed"); },
        record: row => { receipt.cleanup.units.push(row); save(); },
      });
      receipt.cleanup.service_gone = cleaned.service_gone;
      receipt.cleanup.unit_removed = cleaned.unit_removed;
      receipt.cleanup.synthetic_root_removed = cleaned.synthetic_root_removed;
      if (cleaned.errors.length > 0) { receipt.passed = false; failures.push(...cleaned.errors.map(error => `cleanup: ${error}`)); }
      if (!receipt.cleanup.service_gone || !receipt.cleanup.unit_removed) {
        receipt.passed = false;
        failures.push("owned service cleanup remains unverified; synthetic root retained");
      }
    } catch (error) {
      receipt.passed = false;
      failures.push(error instanceof Error ? `cleanup: ${error.message}` : "cleanup failed");
    } finally { save(); }
  }
  if (!receipt.passed) throw new Error(`native service lifecycle failed; receipt=${receiptPath}`);
  return receiptPath;
}

if (import.meta.main) {
  const path = await runNativeServiceLifecycle(Bun.argv.slice(2));
  process.stdout.write(`native service lifecycle passed: ${path}\n`);
}
