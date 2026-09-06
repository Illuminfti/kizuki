import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli, tempDir } = createHelpers();
afterEach(cleanup);

describe("init", () => {
  test("permission repair cannot follow a root replaced after its ownership check", () => {
    const root = tempDir();
    const source = resolve(import.meta.dir, "../../core/src/vault/init.ts");
    const probe = `
      import * as fs from "node:fs";
      import { join } from "node:path";
      import { mock } from "bun:test";
      const root = ${JSON.stringify(root)};
      const vault = join(root, "vault"), moved = join(root, "moved"), outside = join(root, "outside");
      fs.mkdirSync(vault); fs.chmodSync(vault, 0o775);
      fs.mkdirSync(outside); fs.chmodSync(outside, 0o755);
      fs.writeFileSync(join(vault, "note.md"), "synthetic note");
      const nativeFchmod = fs.fchmodSync;
      let swapped = false;
      mock.module("node:fs", () => ({ ...fs, fchmodSync(fd, mode) {
        if (!swapped) { swapped = true; fs.renameSync(vault, moved); fs.symlinkSync(outside, vault); }
        nativeFchmod(fd, mode);
      } }));
      const { initVault } = await import(${JSON.stringify(source)});
      let refused = false;
      try { initVault(vault, { adopt: true }); } catch { refused = true; }
      process.stdout.write(JSON.stringify({ refused, swapped,
        outside_mode: fs.statSync(outside).mode & 0o777,
        original_mode: fs.statSync(moved).mode & 0o777,
        outside_control: fs.existsSync(join(outside, ".kizuki")),
        original_control: fs.existsSync(join(moved, ".kizuki")) }));
    `;
    const result = Bun.spawnSync([process.execPath, "-e", probe], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ refused: true, swapped: true,
      outside_mode: 0o755, original_mode: 0o700, outside_control: false, original_control: true });
  });

  test("stationary permission-repair I/O failure retains bootstrap identities and CLI retry converges", () => {
    const env = isolatedEnv();
    const root = tempDir(), vault = join(root, "vault"), note = join(vault, "owner-note.txt");
    const control = join(vault, ".kizuki"), flock = join(control, "write-pass.flock");
    const trace = join(root, "permission-failure.json"), preload = join(root, "permission-failure.ts");
    const identity = (path: string): { dev: string; ino: string } => {
      const stat = statSync(path, { bigint: true });
      return { dev: stat.dev.toString(), ino: stat.ino.toString() };
    };
    mkdirSync(vault); chmodSync(vault, 0o775);
    writeFileSync(note, "synthetic owner note\n", { mode: 0o600 });
    const originalRoot = identity(vault), originalNote = identity(note);
    writeFileSync(preload, `
      import * as fs from "node:fs";
      import { join } from "node:path";
      import { mock } from "bun:test";
      const vault = ${JSON.stringify(vault)}, trace = ${JSON.stringify(trace)};
      const original = fs.statSync(vault, { bigint: true });
      const nativeFchmod = fs.fchmodSync;
      const identity = path => {
        const stat = fs.statSync(path, { bigint: true });
        return { dev: stat.dev.toString(), ino: stat.ino.toString() };
      };
      let injected = false;
      mock.module("node:fs", () => ({ ...fs, fchmodSync(fd, mode) {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!injected && opened.dev === original.dev && opened.ino === original.ino) {
          injected = true;
          fs.writeFileSync(trace, JSON.stringify({ root: identity(vault),
            control: identity(join(vault, ".kizuki")),
            flock: identity(join(vault, ".kizuki", "write-pass.flock")) }), { mode: 0o600 });
          throw Object.assign(new Error("synthetic permission repair I/O failure"), { code: "EIO" });
        }
        return nativeFchmod(fd, mode);
      } }));
    `, { mode: 0o600 });
    const failed = Bun.spawnSync([process.execPath, "--preload", preload,
      resolve(import.meta.dir, "../src/main.ts"), "init", vault, "--adopt", "--no-service"], {
      env: { ...process.env, ...env, KIZUKI_VAULT: undefined }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout.toString()).toBe("");
    expect(failed.stderr.toString()).toContain("synthetic permission repair I/O failure");
    const captured = JSON.parse(readFileSync(trace, "utf8")) as {
      root: { dev: string; ino: string }; control: { dev: string; ino: string }; flock: { dev: string; ino: string };
    };
    expect(captured.root).toEqual(originalRoot);
    expect(identity(vault)).toEqual(originalRoot);
    expect(identity(control)).toEqual(captured.control);
    expect(identity(flock)).toEqual(captured.flock);
    expect(identity(note)).toEqual(originalNote);
    expect(readFileSync(note, "utf8")).toBe("synthetic owner note\n");
    expect(statSync(vault).mode & 0o777).toBe(0o775);
    expect(statSync(control).mode & 0o777).toBe(0o700);
    expect(statSync(flock).mode & 0o777).toBe(0o600);
    expect(existsSync(join(control, "write-pass.lock"))).toBe(false);
    expect(existsSync(join(control, "init.json"))).toBe(false);
    expect(existsSync(join(control, "kizuki.db"))).toBe(false);
    expect(existsSync(join(vault, "CANON.md"))).toBe(false);

    const retried = runCli(env, "init", vault, "--adopt", "--no-service");
    expect(retried.exitCode, retried.stderr).toBe(0);
    expect(statSync(vault).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(join(control, "init.json"), "utf8"))).toMatchObject({
      schema: "kizuki.init/v1", status: "ready", adopt: { policy: "adopt" },
    });
    expect(existsSync(join(control, "kizuki.db"))).toBe(true);
    expect(runCli(env, "init", vault, "--no-service", "--no-default").exitCode).toBe(0);
    const doctor = runCli({ ...env, KIZUKI_VAULT: vault }, "doctor");
    expect(doctor.exitCode, `${doctor.stdout}\n${doctor.stderr}`).toBe(0);
    expect(identity(vault)).toEqual(originalRoot);
    expect(identity(control)).toEqual(captured.control);
    expect(identity(flock)).toEqual(captured.flock);
    expect(identity(note)).toEqual(originalNote);
    expect(readFileSync(note, "utf8")).toBe("synthetic owner note\n");
    expect(existsSync(join(control, "write-pass.lock"))).toBe(false);
  });

  test("writes owner-only control files and a ready journal", () => {
    const env = isolatedEnv();
    const vault = join(tempDir(), "vault");
    const previous = process.umask(0o000);
    let result;
    try {
      result = runCli(env, "init", vault, "--no-service");
    } finally {
      process.umask(previous);
    }
    expect(result.exitCode).toBe(0);
    expect(statSync(join(vault, ".kizuki")).mode & 0o777).toBe(0o700);
    expect(statSync(join(vault, ".kizuki", "kizuki.db")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(vault, "SCHEMA.md"), "utf8")).toContain("kizuki.doctrine/v2");
    expect(readFileSync(join(vault, "SCHEMA.md"), "utf8")).not.toContain("reviewed Markdown");
    expect(JSON.parse(readFileSync(join(vault, ".kizuki", "init.json"), "utf8"))).toMatchObject({
      schema: "kizuki.init/v1",
      status: "ready",
    });
  });

  test("refuses a non-empty directory and adopts only when asked", () => {
    const env = isolatedEnv();
    const vault = join(tempDir(), "notes");
    mkdirSync(vault);
    chmodSync(vault, 0o775);
    writeFileSync(join(vault, "inbox.md"), "a personal note\n");

    const refused = runCli(env, "init", vault, "--no-service");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("pass --adopt to take ownership");
    expect(refused.stderr).toContain("entry inbox.md");
    expect(existsSync(join(vault, ".kizuki"))).toBe(false);
    expect(statSync(vault).mode & 0o777).toBe(0o775);

    const dry = runCli(env, "init", vault, "--adopt", "--dry-run", "--no-service");
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("dry-run");
    expect(dry.stdout).toContain("entry inbox.md");
    expect(existsSync(join(vault, ".kizuki"))).toBe(false);
    expect(statSync(vault).mode & 0o777).toBe(0o775);

    const adopted = runCli(env, "init", vault, "--adopt", "--no-service");
    expect(adopted.exitCode).toBe(0);
    expect(adopted.stdout).toContain("adopt entries=1");
    expect(statSync(vault).mode & 0o777).toBe(0o700);
    expect(existsSync(join(vault, ".kizuki", "kizuki.db"))).toBe(true);
    expect(readFileSync(join(vault, "inbox.md"), "utf8")).toBe("a personal note\n");
    expect(JSON.parse(readFileSync(join(vault, ".kizuki", "init.json"), "utf8")).adopt.policy).toBe(
      "adopt",
    );
  });

  test("later commands refuse an insecure control directory", () => {
    const env = isolatedEnv();
    const vault = join(tempDir(), "open");
    expect(runCli(env, "init", vault, "--no-service").exitCode).toBe(0);
    chmodSync(join(vault, ".kizuki"), 0o755);
    const doctor = runCli({ ...env, KIZUKI_VAULT: vault }, "doctor");
    expect(doctor.exitCode).toBe(1);
    expect(doctor.stderr).toContain("not owner-only");
  });

  test("repeated init converges after a partial journal", () => {
    const env = isolatedEnv();
    const vault = join(tempDir(), "again");
    expect(runCli(env, "init", vault, "--no-service").exitCode).toBe(0);
    writeFileSync(
      join(vault, ".kizuki", "init.json"),
      `${JSON.stringify({
        schema: "kizuki.init/v1",
        status: "in_progress",
        doctrine_version: 2,
        adopt: null,
      })}\n`,
    );
    const again = runCli(env, "init", vault, "--no-service", "--no-default");
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(vault, ".kizuki", "init.json"), "utf8")).status).toBe(
      "ready",
    );
    expect(runCli({ ...env, KIZUKI_VAULT: vault }, "doctor").exitCode).toBe(0);
  });
});
