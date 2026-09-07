import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join, resolve } from "node:path";
import { installServeService, realSupervisorHost } from "../packages/core/src/serve/supervisor";
import { HEARTBEAT_SECONDS, LEASE_RECLAIM_HEARTBEATS } from "../packages/core/src/serve/types";
import { parseBuildInfo, parseProofArgs } from "./stranger-proof";
import { requireRegularFile, verifyChecksumManifest } from "./release-artifacts";
import { releaseTarget, requireNativeHost } from "./release-targets";
import { installedRailsHealth, readNativeRailDiagnostics, recordInstalledHealth, waitForFreshRails } from "./native-service-health";
import { captureSyntheticServiceTrace } from "./native-service-trace";
import { prepareLaunchctlDiagnostics, projectLaunchctlResult, syntheticServiceFileMetadata } from "./native-launchctl-diagnostics";

const repository = resolve(import.meta.dir, "..");
const packageFiles = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"] as const;
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

/** The actual cleanup removal boundary, shared with the refusal regression oracle. */
export function cleanupStoppedNativeFixture(
  platform: string, state: CommandResult, fixtureRoot: string, unitPath: string, afterUnitRemoved: () => void = () => {},
): { service_gone: boolean; unit_removed: boolean; synthetic_root_removed: boolean } {
  if (!nativeServiceStopped(platform, state)) {
    return { service_gone: false, unit_removed: !existsSync(unitPath), synthetic_root_removed: false };
  }
  if (existsSync(unitPath)) unlinkSync(unitPath);
  afterUnitRemoved();
  rmSync(fixtureRoot, { recursive: true });
  return { service_gone: true, unit_removed: true, synthetic_root_removed: true };
}

/** Real native CI only: this harness loads one unique synthetic user service. */
export async function runNativeServiceLifecycle(argv: readonly string[]): Promise<string> {
  const args = parseProofArgs(argv);
  mkdirSync(args.report, { recursive: true, mode: 0o700 });
  const receiptPath = join(args.report, "receipt.json");
  check(!existsSync(receiptPath), "refusing to replace a lifecycle receipt");
  const steps: Step[] = [];
  const failures: string[] = [];
  const receipt = {
    schema: "kizuki.native-service-lifecycle/v1", source_sha: "unavailable", target: "unavailable",
    host: { platform: process.platform, arch: process.arch, kernel: release(), bun: Bun.version, uid: process.getuid?.() ?? null },
    binary_sha256: "unavailable", package_sha256: {} as Record<string, string>, steps, failures,
    scope: { native_user_service: true, synthetic_vault_only: true, release_upgrade: false, migration_rollback: false, configured_model: false },
    passed: false, cleanup: { attempted: false, service_gone: false, unit_removed: false, synthetic_root_removed: false },
  };
  const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  const record = (id: string, passed: boolean, evidence: unknown) => { steps.push({ id, passed, evidence }); save(); check(passed, `${id} failed`); };
  let fixtureRoot: string | null = null;
  let vault = "", unit = "", unitPath = "", executable = "";
  let cliEnv: Record<string, string> = {};
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
    verifyChecksumManifest(args.artifact, packageFiles);
    const build = parseBuildInfo(join(args.artifact, "BUILD.json"));
    requireNativeHost(releaseTarget(build.target));
    check(build.source_sha === sourceSha && build.bun_version === Bun.version, "package is not the exact native source candidate");
    receipt.target = build.target;
    check(process.env.RUNNER_TEMP, "native lifecycle proof requires the runner temporary directory");
    // A systemd PrivateTmp service cannot see a fixture placed under /tmp.
    fixtureRoot = realpathSync(mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), "kizuki native lifecycle ")));
    const home = join(fixtureRoot, "home");
    mkdirSync(home, { mode: 0o700 });
    const copied = join(fixtureRoot, "installed package");
    cpSync(args.artifact, copied, { recursive: true, dereference: false, errorOnExist: true });
    verifyChecksumManifest(copied, packageFiles);
    executable = join(copied, "kizuki");
    for (const name of [...packageFiles, "SHA256SUMS"]) {
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
      const diagnostic = initialDiagnostic ?? prepareLaunchctlDiagnostics(fixtureRoot, vaultId);
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
    for (const name of [...packageFiles, "SHA256SUMS"]) check(hash(join(copied, name)) === receipt.package_sha256[name] && hash(join(args.artifact, name)) === receipt.package_sha256[name], "package changed during lifecycle proof");
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
    receipt.cleanup.attempted = true;
    try {
      if (unit) {
        // Cleanup remains restricted to the name generated inside this synthetic vault.
        if (executable) invoke([executable, "serve", "--uninstall", "--json", "--vault", vault]);
        if (platform === "darwin") native("bootout", `${domain}/${unit}`);
        else native("--user", "disable", "--now", unit);
        check(fixtureRoot !== null, "cleanup fixture identity missing");
        Object.assign(receipt.cleanup, cleanupStoppedNativeFixture(platform, managerState(), fixtureRoot, unitPath, () => {
          if (platform === "linux") check(native("--user", "daemon-reload").exit_code === 0, "cleanup manager reload failed");
        }));
      } else {
        receipt.cleanup.service_gone = true;
        receipt.cleanup.unit_removed = true;
      }
      if (receipt.cleanup.service_gone && receipt.cleanup.unit_removed && !receipt.cleanup.synthetic_root_removed && fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true });
        receipt.cleanup.synthetic_root_removed = true;
      }
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
