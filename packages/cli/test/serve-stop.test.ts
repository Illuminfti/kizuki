import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readBootId, readLease } from "@kizuki/core";
import { openLedger } from "../../core/src/ledger/db";
import { createHelpers } from "./helpers";

const helpers = createHelpers();
afterEach(() => helpers.cleanup());

for (const mode of ["current-boot-unrelated-pid", "boot-mismatch", "legacy-pid"])
  test(`serve stop never signals an unrelated process from a marker: ${mode}`, async () => {
    const fixture = helpers.tempVault();
    const signalPath = join(fixture.root, "sentinel-signaled");
    const sentinel = Bun.spawn([process.execPath, "--eval", `
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(signalPath)}, "SYNTHETIC_SIGTERM"); process.exit(0); });
      setInterval(() => {}, 1000);
      process.stdout.write("ready");
    `], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = sentinel.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready");
      reader.releaseLock();
      const marker = mode === "legacy-pid" ? String(sentinel.pid) : JSON.stringify({
        pid: sentinel.pid, boot_id: mode === "boot-mismatch" ? "synthetic-previous-boot" : readBootId(), instance_id: crypto.randomUUID(),
      });
      writeFileSync(join(fixture.vault, ".kizuki", "serve.pid"), marker, { mode: 0o600 });
      const result = helpers.runCli(fixture.env, "serve", "stop", "--vault", fixture.vault);
      await Bun.sleep(100);
      expect(existsSync(signalPath), result.stdout + result.stderr).toBe(false);
      expect(sentinel.exitCode).toBeNull();
      if (mode === "legacy-pid") expect(result.exitCode).not.toBe(0);
    } finally {
      if (sentinel.exitCode === null) sentinel.kill("SIGKILL");
      await sentinel.exited;
    }
  });

test("public CLI queues graceful shutdown of a real daemon without claiming it has stopped", async () => {
  const f = helpers.tempVault(), marker = join(f.vault, ".kizuki/serve.pid");
  const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "serve", "--no-http", "--vault", f.vault], {
    env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline && daemon.exitCode === null) await Bun.sleep(25);
    expect(existsSync(marker)).toBe(true);
    const instance = JSON.parse(readFileSync(marker, "utf8")).instance_id;
    const stopped = helpers.runCli(f.env, "serve", "stop", "--json", "--vault", f.vault);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout).data).toEqual({ status: "queued", instance_id: instance });
    expect(stopped.stdout).not.toContain("stopped");
    const exit = await Promise.race([daemon.exited, Bun.sleep(5000).then(() => "timeout")]);
    expect(exit).toBe(0); expect(existsSync(marker)).toBe(false);
    const db = openLedger(join(f.vault, ".kizuki/kizuki.db"));
    try { expect(readLease(db, "writer")).toBeNull(); } finally { db.close(); }
  } finally {
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
    await daemon.exited;
  }
});
