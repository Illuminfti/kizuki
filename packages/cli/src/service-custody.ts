import { SERVICE_BROKER_REAP_SECONDS, SERVICE_READY_SECONDS, SERVICE_REFUSAL_EXIT, ServiceCustodyError, validateServiceCustodyLaunch } from "@kizuki/core/internal";
import type { ServiceCustodyFailure } from "@kizuki/core/internal";
import { serveExecHint } from "@kizuki/core";
import type { SupervisorLastExit, SupervisorStatus } from "@kizuki/core";
import { INVOCATION, serveArgs, shellQuote } from "./runtime";

/** ExecStartPost must exit after readiness while its broker remains in the
 * same unit cgroup. Only the exact subprocess created here is ever signalled. */
export async function launchServiceCustodyBroker(
  vaultPath: string, vaultId: string, env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  validateServiceCustodyLaunch(vaultPath, vaultId, env);
  const child = Bun.spawn([...serveArgs(vaultPath), "--custody-broker-child", vaultId], {
    env: { ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reader = child.stdout.getReader();
  try {
    const expected = Buffer.from("READY\n");
    await Promise.race([
      (async () => {
        let received = Buffer.alloc(0);
        while (received.length < expected.length) {
          const result = await reader.read();
          if (result.done || received.length + result.value.length > expected.length) throw new ServiceCustodyError();
          received = Buffer.concat([received, result.value]);
        }
        if (!received.equals(expected) || child.exitCode !== null) throw new ServiceCustodyError();
      })(),
      child.exited.then(() => { throw new ServiceCustodyError(); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceCustodyError()), SERVICE_READY_SECONDS * 1_000); }),
    ]);
    ready = true;
    child.unref();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await reader.cancel();
    reader.releaseLock();
    await child.stderr.cancel();
    if (!ready) {
      child.kill("SIGTERM");
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([child.exited, new Promise<void>(resolve => {
          killTimer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, SERVICE_BROKER_REAP_SECONDS * 1_000);
        })]);
        await child.exited;
      } finally { if (killTimer !== undefined) clearTimeout(killTimer); }
    }
  }
}

/** Custody can also be lost after the daemon has been running, which is not a
 * startup refusal and never shares its copy. */
export type CustodyFailureReason = ServiceCustodyFailure | "custody_lost";

/** Refusals that repeat identically on every start. Only these exit with
 * SERVICE_REFUSAL_EXIT, which the unit never restarts. An unproven or lost
 * custody may be transient (a slow broker under the CPU quota), so it exits 1
 * and the unit's start limit bounds a real loop. */
const DETERMINISTIC_REFUSALS: ReadonlySet<string> = new Set(["unsupported_platform", "not_supervised", "root_user", "vault_mismatch", "migration_required"]);
export function serviceStartupExit(reason: CustodyFailureReason | "migration_required"): number {
  return DETERMINISTIC_REFUSALS.has(reason) ? SERVICE_REFUSAL_EXIT : 1;
}

function inspectUnitLines(unit: string | null): string[] {
  return unit === null ? [] : [`see: journalctl --user -u ${unit} -n 50`];
}

/** A supervised start explains itself only through the service log, so the
 * refusal has to carry what was observed and the command that follows from it.
 * Most guards here also fire on a hijack attempt, so only conditions the
 * daemon read directly are stated as the cause; the rest are offered as
 * possibilities and never as a diagnosis the service did not make. */
export function custodyUnavailableMessage(
  vaultPath: string,
  unit: string | null = null,
  reason: CustodyFailureReason = "custody_unproven",
  machine = `${process.platform} ${process.arch}`,
): string {
  const head = "service_custody_unavailable:";
  if (reason === "unsupported_platform") {
    return [
      `${head} the background service holds vault custody only on Linux x64, and this machine reports ${machine}.`,
      "The installed unit cannot start here; nothing about the vault is wrong.",
      `remove the unit: ${INVOCATION} serve --uninstall --vault ${vaultPath}`,
      `run the loop yourself: ${serveExecHint(vaultPath)}`,
    ].join("\n");
  }
  if (reason === "not_supervised") {
    return [
      `${head} this launch mode belongs to the installed unit, and this process carries no proof that the supervisor started it.`,
      `run the loop yourself instead: ${serveExecHint(vaultPath)}`,
      ...inspectUnitLines(unit),
    ].join("\n");
  }
  if (reason === "root_user") {
    return [
      `${head} the background service refuses to run as root; it must run as the user who owns ${vaultPath}.`,
      `install it as that user: ${INVOCATION} serve --install --vault ${vaultPath}`,
      ...inspectUnitLines(unit),
    ].join("\n");
  }
  if (reason === "vault_mismatch") {
    return [
      `${head} the installed unit names a vault id or path that does not match ${vaultPath} (its .kizuki/vault-id changed, or the vault was moved, replaced or restored).`,
      "The unit will not start again until it is rebound; nothing was written.",
      `reinstall it for this vault: ${INVOCATION} serve --install --vault ${shellQuote(vaultPath)}`,
    ].join("\n");
  }
  if (reason === "custody_lost") {
    return [
      `${head} the service lost its proof of custody of ${vaultPath} while running and stopped rather than keep writing with authority it can no longer prove.`,
      ...inspectUnitLines(unit),
      `then confirm the vault: ${INVOCATION} doctor --vault ${vaultPath}`,
    ].join("\n");
  }
  return [
    `${head} the background service could not prove it holds custody of ${vaultPath}, and the check it stopped on is not named here.`,
    "possible causes: the vault or its .kizuki directory is writable by anyone but you; a directory above the vault changed while the service started, which a shared directory such as /tmp does; or something other than the installed unit tried to start the service.",
    ...inspectUnitLines(unit),
    `then confirm the vault: ${INVOCATION} doctor --vault ${vaultPath}`,
    // A transient refusal is retried within the unit's start limit; name the restart for when it is not.
    ...(unit === null ? [] : [`systemd retries this start within its start limit; if the unit stays failed, restart it: systemctl --user reset-failed ${unit} && systemctl --user start ${unit}`]),
  ].join("\n");
}

/** systemd calls a Type=simple unit active as soon as ExecStart forks, so the
 * installer's confirmation is not evidence that the loop kept running. The
 * window covers a startup refusal, which the daemon raises while opening vault
 * custody, not the whole READY budget a supervisor allows. */
export const SERVICE_SETTLE_MS = 5_000;
export const SERVICE_SAMPLE_MS = 500;

export interface ObserveServiceOptions {
  readonly settleMs?: number;
  readonly sampleMs?: number;
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
}

export function serviceRunning(status: SupervisorStatus): boolean {
  return status.state === "active" && status.enabled;
}

/** Watch an installed unit until it stops running or the window closes, and
 * return the sample that was actually observed. Nothing is inferred. */
export async function observeInstalledService(
  query: () => SupervisorStatus,
  options: ObserveServiceOptions = {},
): Promise<SupervisorStatus> {
  const settleMs = options.settleMs ?? SERVICE_SETTLE_MS;
  const sampleMs = options.sampleMs ?? SERVICE_SAMPLE_MS;
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const deadline = now() + settleMs;
  let status = query();
  while (serviceRunning(status) && now() < deadline) {
    await wait(Math.min(sampleMs, Math.max(0, deadline - now())));
    status = query();
  }
  return status;
}

/** The coarse SupervisorState folds a crashed unit into `disabled` and a
 * restarting one into `unknown`. The supervisor's own word survives in the
 * detail; a stranger needs that word, not the category. A detail that reports
 * the query or the host instead of the unit is not a state and is never
 * borrowed as one, including the sentence a host with no supervisor returns in
 * place of one. */
export function observedSupervisorState(status: SupervisorStatus): string {
  const describesHost = status.kind === "none" || status.detail.startsWith("supervisor");
  return status.detail.length === 0 || describesHost ? status.state : status.detail;
}

function inspectCommand(status: SupervisorStatus): string | null {
  if (status.unit === null) return null;
  if (status.kind === "systemd") return `journalctl --user -u ${status.unit} -n 50`;
  if (status.kind === "launchd") return `launchctl print gui/$(id -u)/${status.unit}`;
  return null;
}

/** Init prints this instead of a state it did not observe. */
export function serviceNotRunningLines(status: SupervisorStatus, vaultPath: string): string[] {
  const inspect = inspectCommand(status);
  return [
    `service not running: ${status.unit ?? status.kind} was installed but did not stay running; supervisor state ${observedSupervisorState(status)}`,
    ...(inspect === null ? [] : [`why: ${inspect}`]),
    `meanwhile run the loop yourself: ${serveExecHint(vaultPath)}`,
  ];
}

/** The command that follows from how an installed systemd unit last ended,
 * so doctor never answers a failed unit with only a pointer to its log. */
function restartStep(status: SupervisorStatus, exit: SupervisorLastExit | null, vaultPath: string | null): string | null {
  if (status.kind !== "systemd" || status.unit === null || exit === null || status.state === "active") return null;
  const unit = status.unit, restart = `systemctl --user reset-failed ${unit} && systemctl --user start ${unit}`;
  if (exit.exit_status === SERVICE_REFUSAL_EXIT) {
    return `last exit ${SERVICE_REFUSAL_EXIT} is a startup refusal systemd does not restart; fix the refusal journalctl --user -u ${unit} -n 50 names, then reinstall: ${INVOCATION} serve --install --vault ${vaultPath === null ? "<vault>" : shellQuote(vaultPath)}`;
  }
  if (exit.result === "start-limit-hit") return `systemd stopped restarting it after repeated failed starts; restart it: ${restart}`;
  if (exit.result !== "success") {
    return `last run ended with ${exit.result}${exit.exit_status === null ? "" : ` (exit status ${exit.exit_status})`}; restart it: ${restart}`;
  }
  return status.enabled ? `start it: systemctl --user start ${unit}` : null;
}

/** Doctor's supervisor failure, re-rendered from the status it was derived
 * from. Unrelated failures are returned untouched. */
export function supervisorFailureLine(failure: string, status: SupervisorStatus, exit: SupervisorLastExit | null = null, vaultPath: string | null = null): string {
  if (!/^supervisor (unknown|active|disabled|masked|absent|none)( but not enabled)?$/.test(failure)) return failure;
  const inspect = inspectCommand(status), observed = observedSupervisorState(status), step = restartStep(status, exit, vaultPath);
  return `supervisor ${status.unit ?? status.kind} state=${observed}`
    + ` enabled=${status.enabled ? "yes" : "no"}${status.detail === observed ? "" : ` (${status.detail})`}`
    + (step !== null ? `; ${step}` : inspect === null ? "" : `; see: ${inspect}`);
}
