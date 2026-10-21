import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const { cleanup, isolatedEnv, runCli, tempVault } = createHelpers();
afterEach(cleanup);

test("backup help matches its parser and the usage errors are exact", () => {
  const env = isolatedEnv();
  const help = JSON.parse(runCli(env, "backup", "--help", "--json").stdout) as { data: { name: string; options: string[]; flags: string[] } };
  expect(help.data).toMatchObject({ name: "backup", options: ["--out", "--wait"], flags: [] });
  for (const [args, diagnostic] of [
    [["backup"], "usage: kizuki backup --out DIR"],
    [["backup", "--out", "./b", "--wait", "soon"], "usage: kizuki backup --out DIR"],
    [["backup", "--out", "./b", "--wait", "99999"], "usage: kizuki backup --out DIR"],
    [["backup", "--nope"], "unknown option --nope"],
    [["backup", "--out"], "missing value for --out"],
    [["backup", "extra"], "invalid arguments"],
  ] as const) {
    const result = runCli(env, ...args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(diagnostic);
  }
});

test("backup snapshots a vault whose source never granted export, verifies, and refuses a used directory", () => {
  const f = tempVault();
  const file = join(f.root, "no-export-policy.json");
  writeFileSync(file, JSON.stringify({ purposes: ["capture", "recall", "session", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" }), { mode: 0o600 });
  expect(runCli(f.env, "import", "markdown-folder", "--source", f.notes, "--policy", file, "--expected-revision", "0", "--operation-id", "no-export").exitCode).toBe(0);
  expect(runCli(f.env, "export", "--out", join(f.root, "export")).stderr).toContain("source_export_denied");
  const out = join(f.root, "snapshot");
  const backup = runCli(f.env, "backup", "--out", out, "--wait", "5");
  expect(backup.exitCode, backup.stderr).toBe(0);
  expect(backup.stdout).toContain(`manifest=${out}/manifest.json`);
  expect(backup.stdout).toContain("events=3");
  expect(existsSync(join(out, "ledger.db"))).toBe(true);
  expect(runCli(f.env, "restore", "--from", out, "--verify").stdout).toContain("schema=kizuki.snapshot/v1 complete=true");
  const again = runCli(f.env, "backup", "--out", out);
  expect(again.exitCode).toBe(1);
  expect(again.stderr).toContain("not empty");
  expect(existsSync(join(f.vault, "snapshot"))).toBe(false);
  const inside = runCli(f.env, "backup", "--out", join(f.vault, "inside"));
  expect(inside.exitCode).toBe(1);
  expect(inside.stderr).toContain("must not be inside the vault");
});

test("the scheduled backup rail produces an archive the real restore command verifies into an empty vault", () => {
  const f = tempVault(), destination = join(f.root, "scheduled-backups"), target = join(f.root, "scheduled-restored");
  const policy = join(f.root, "scheduled-policy.json");
  writeFileSync(policy, JSON.stringify({ purposes: ["capture", "recall", "derive", "export"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" }), { mode: 0o600 });
  expect(runCli(f.env, "import", "markdown-folder", "--source", f.notes, "--policy", policy, "--expected-revision", "0", "--operation-id", "scheduled-fixture").exitCode).toBe(0);
  writeFileSync(join(f.vault, ".kizuki/serve.toml"), `[backup]\ndir=${JSON.stringify(destination)}\nretain=2\n`, { mode: 0o600 });
  const ran = runCli(f.env, "serve", "run", "backup", "--json");
  expect(ran.exitCode, ran.stderr + ran.stdout).toBe(0);
  const receipt = JSON.parse(ran.stdout).data;
  expect(receipt).toMatchObject({ rail: "backup", status: "ok", errors: [], model: { calls: 0 } });
  const directories = readdirSync(destination);
  expect(directories).toHaveLength(1);
  expect(directories[0]).toContain(receipt.run_id);
  const restored = runCli(f.env, "restore", "--from", join(destination, directories[0]!), "--into", target, "--verify");
  expect(restored.exitCode, restored.stderr).toBe(0);
  expect(restored.stdout).toContain("events=3");
  expect(restored.stdout).toContain("doctor_invalid=0");
  expect(existsSync(join(target, ".kizuki/kizuki.db"))).toBe(true);
});
