import { SERVICE_BROKER_REAP_SECONDS, SERVICE_READY_SECONDS, ServiceCustodyError, validateServiceCustodyLaunch } from "@kizuki/core/internal";
import { serveArgs } from "./runtime";

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
