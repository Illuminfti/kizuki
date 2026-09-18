import { SERVICE_BROKER_REAP_SECONDS, SERVICE_READY_SECONDS, ServiceCustodyError, validateServiceCustodyLaunch } from "@kizuki/core/internal";
import { serveExecHint } from "@kizuki/core";
import type { SupervisorStatus } from "@kizuki/core";
import { INVOCATION, serveArgs } from "./runtime";

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

/** A supervised start explains itself only through the service log, so the
 * refusal has to carry the prerequisite and the command that proves it. */
export function custodyUnavailableMessage(vaultPath: string): string {
  return [
    `service_custody_unavailable: the background service could not confirm who owns the directories above ${vaultPath}.`,
    "Every directory above the vault must be owned by you or by root and must stay unchanged while the service starts.",
    "A shared directory such as /tmp does not qualify; it changes while the service is starting.",
    `Create the vault somewhere only you write, such as your home directory: ${INVOCATION} init <path> --adopt`,
    `Then confirm it: ${INVOCATION} doctor --vault <path>`,
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
 * detail; a stranger needs that word, not the category. A detail that only
 * reports the query itself is not a state and is never borrowed as one. */
export function observedSupervisorState(status: SupervisorStatus): string {
  return status.detail.length === 0 || status.detail.startsWith("supervisor ") ? status.state : status.detail;
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

/** Doctor's supervisor failure, re-rendered from the status it was derived
 * from. Unrelated failures are returned untouched. */
export function supervisorFailureLine(failure: string, status: SupervisorStatus): string {
  if (!/^supervisor (unknown|active|disabled|masked|absent|none)( but not enabled)?$/.test(failure)) return failure;
  const inspect = inspectCommand(status), observed = observedSupervisorState(status);
  return `supervisor ${status.unit ?? status.kind} state=${observed}`
    + ` enabled=${status.enabled ? "yes" : "no"}${status.detail === observed ? "" : ` (${status.detail})`}`
    + `${inspect === null ? "" : `; see: ${inspect}`}`;
}
