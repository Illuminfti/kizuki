import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers, fixtureConsent } from "./helpers";

const h = createHelpers();
afterEach(h.cleanup);

function exported(capture = true) {
  const setup = h.tempVault();
  const connected = capture
    ? h.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root))
    : h.runCli(setup.env, "connect", "markdown-folder", "--source", setup.notes);
  expect(connected.exitCode, connected.stderr).toBe(0);
  const db = new Database(join(setup.vault, ".kizuki/kizuki.db"), { readonly: true });
  let sourceKey: string;
  try { sourceKey = (db.query("SELECT source_key FROM connections").get() as { source_key: string }).source_key; }
  finally { db.close(); }
  if (!capture) {
    const grant = h.runCli(setup.env, "connect", "grant", "--source", sourceKey, ...fixtureConsent(setup.root));
    expect(grant.exitCode, grant.stderr).toBe(0);
  }
  const backup = join(setup.root, "snapshot"), into = join(setup.root, "restored");
  const result = h.runCli(setup.env, "export", "--out", backup);
  expect(result.exitCode, result.stderr).toBe(0);
  const relative = "connections/portable-local.v1.jsonl", state = join(backup, relative);
  expect(existsSync(state)).toBe(true);
  return { ...setup, backup, into, relative, state, sourceKey };
}

test("export verification binds the portable state required for a healthy none-auth restore", () => {
  const f = exported();
  const manifest = JSON.parse(readFileSync(join(f.backup, "manifest.json"), "utf8"));
  const verified = h.runCli(f.env, "restore", "--from", f.backup, "--verify");
  const restored = h.runCli(f.env, "restore", "--from", f.backup, "--into", f.into);
  const doctor = h.runCli(f.env, "doctor", "--vault", f.into);
  console.log(JSON.stringify({ case: "healthy", state_bound: Object.hasOwn(manifest.files, f.relative), verify_exit: verified.exitCode, restore_exit: restored.exitCode, doctor_exit: doctor.exitCode }));
  expect(verified.exitCode).toBe(0); expect(restored.exitCode).toBe(0); expect(doctor.exitCode).toBe(0);
  expect(Object.hasOwn(manifest.files, f.relative)).toBe(true);
  writeFileSync(join(f.notes, "resumed.md"), "synthetic_resumed_original_source\n", { mode: 0o600 });
  const synced = h.runCli({ ...f.env, KIZUKI_VAULT: f.into }, "sync", "markdown-folder");
  expect(synced.exitCode, synced.stderr).toBe(0);
  const db = new Database(join(f.into, ".kizuki/kizuki.db"), { readonly: true });
  try {
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE text LIKE '%synthetic_resumed_original_source%'").get()).toEqual({ n: 1 });
    expect(db.query("SELECT source_key FROM connections WHERE disconnected_at IS NULL").get()).toEqual({ source_key: f.sourceKey });
  } finally { db.close(); }
});

for (const mutation of ["missing", "malformed", "symlink"] as const) {
  test(`public restore refuses ${mutation} portable state before publishing the target`, () => {
    const f = exported();
    if (mutation === "malformed") writeFileSync(f.state, "synthetic invalid state bytes", { mode: 0o600 });
    else {
      unlinkSync(f.state);
      if (mutation === "symlink") {
        const outside = join(f.root, "synthetic-external-state");
        writeFileSync(outside, "synthetic external private bytes", { mode: 0o600 });
        symlinkSync(outside, f.state);
      }
    }
    const verified = h.runCli(f.env, "restore", "--from", f.backup, "--verify");
    const restored = h.runCli(f.env, "restore", "--from", f.backup, "--into", f.into);
    const targetState = join(f.into, ".kizuki/connections", `${f.sourceKey}.state`);
    const copiedOutside = mutation === "symlink" && existsSync(targetState) && readFileSync(targetState, "utf8") === "synthetic external private bytes";
    console.log(JSON.stringify({ case: mutation, verify_exit: verified.exitCode, restore_exit: restored.exitCode, target_published: existsSync(f.into), outside_bytes_copied: copiedOutside }));
    expect(copiedOutside).toBe(false);
    expect(verified.exitCode).not.toBe(0);
    expect(restored.exitCode).not.toBe(0);
    expect(existsSync(f.into)).toBe(false);
  });
}

test("unmanifested state cannot redirect an existing capture grant to another local source", () => {
  const f = exported(false), other = join(f.root, "other-source");
  mkdirSync(other, { mode: 0o700 });
  writeFileSync(join(other, "unapproved.md"), "synthetic_unapproved_source_canary\n", { mode: 0o600 });
  const parsed = JSON.parse(readFileSync(f.state, "utf8")); parsed.path = other;
  writeFileSync(f.state, JSON.stringify(parsed) + "\n", { mode: 0o600 });
  const verified = h.runCli(f.env, "restore", "--from", f.backup, "--verify");
  const restored = h.runCli(f.env, "restore", "--from", f.backup, "--into", f.into);
  let syncExit: number | null = null, captured = false, sameSourceKey = false;
  if (restored.exitCode === 0) {
    const synced = h.runCli({ ...f.env, KIZUKI_VAULT: f.into }, "sync", "markdown-folder");
    syncExit = synced.exitCode;
    const db = new Database(join(f.into, ".kizuki/kizuki.db"), { readonly: true });
    try {
      captured = db.query("SELECT 1 FROM events WHERE text LIKE '%synthetic_unapproved_source_canary%'").get() !== null;
      sameSourceKey = (db.query("SELECT source_key FROM connections WHERE disconnected_at IS NULL").get() as { source_key?: string } | null)?.source_key === f.sourceKey;
    } finally { db.close(); }
  }
  console.log(JSON.stringify({ case: "retargeted-source", verify_exit: verified.exitCode, restore_exit: restored.exitCode, sync_exit: syncExit, unapproved_capture: captured, same_source_key: sameSourceKey }));
  expect(captured).toBe(false);
  expect(verified.exitCode).not.toBe(0);
  expect(restored.exitCode).not.toBe(0);
});
