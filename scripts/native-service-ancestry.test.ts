import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const linux = test.if(process.platform === "linux" && process.arch === "x64" && process.geteuid?.() !== 0);
const main = resolve(import.meta.dir, "../packages/cli/src/main.ts");

for (const mode of ["source", "compiled"] as const) {
  linux(`${mode} default HTTP daemon runs every rail and consumes public stop beneath a traversal-only ancestor`, async () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-serve-ancestry-"));
    const ancestor = join(root, "ancestor"), vault = join(ancestor, "synthetic vault");
    const env = { PATH: process.env.PATH!, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg"),
      KIZUKI_CONFIG: join(root, "config.toml"), KIZUKI_SUPERVISOR: "none" };
    let child: ReturnType<typeof Bun.spawn> | undefined;
    mkdirSync(env.HOME, { mode: 0o700 }); mkdirSync(ancestor, { mode: 0o700 });
    try {
      let argv = [process.execPath, main];
      if (mode === "compiled") {
        const binary = join(root, "kizuki");
        const options = { entrypoints: [main], compile: { target: "bun-linux-x64-baseline", outfile: binary,
          autoloadDotenv: false, autoloadBunfig: false }, define: { KIZUKI_COMPILED: "true" } };
        const build = Bun.spawnSync([process.execPath, "--eval", `const result = await Bun.build(${JSON.stringify(options)}); if (!result.success) throw new Error('synthetic CLI build failed');`],
          { env, cwd: resolve(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
        expect(build.exitCode).toBe(0);
        argv = [binary];
      }
      const invoke = (...args: string[]) => Bun.spawnSync([...argv, ...args], { env, cwd: root,
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      expect(invoke("init", vault, "--no-service").exitCode).toBe(0);
      chmodSync(ancestor, 0o100);
      child = Bun.spawn([...argv, "serve", "--vault", vault], { env, cwd: vault, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      let rails: { rail: string; status: string; errors: string[] }[] = [];
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && child.exitCode === null) {
        const db = new Database(join(vault, ".kizuki/kizuki.db"), { readonly: true });
        try {
          rails = (db.query("SELECT rail,status,report FROM run_receipts").all() as { rail: string; status: string; report: string }[])
            .map(row => ({ rail: row.rail, status: row.status, errors: JSON.parse(row.report).errors }));
        } finally { db.close(); }
        if (rails.length === 7) break;
        await Bun.sleep(50);
      }
      // Observe stop independently even when health failed, matching the native oracle.
      const stop = invoke("serve", "stop", "--vault", vault);
      const stopDeadline = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < stopDeadline) await Bun.sleep(50);
      expect({ rails, stopExit: stop.exitCode, daemonExit: child.exitCode }).toEqual({
        rails: expect.arrayContaining(["sync", "retrieval-sweep", "purge-sweep", "embed-backfill", "brief", "doctor-sweep", "journal-prune"]
          .map(rail => ({ rail, status: "ok", errors: [] }))), stopExit: 0, daemonExit: 0,
      });
      expect(rails).toHaveLength(7);
    } finally {
      if (child && child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
      chmodSync(ancestor, 0o700);
      rmSync(root, { force: true, recursive: true });
    }
  }, 20_000);
}
