import { afterEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHelpers, fixtureConsent } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

// Regression for #555: a vault restored from a complete backup came back
// with its connections table intact (same source_key, same checkpoint) but
// its connection state file gone, and its derived event index un-rebuilt —
// so doctor reported a fresh restore as unhealthy even though nothing was
// actually lost. `export` copies a `none`-auth connector's connection state
// (never a credential, see connections.ts) alongside its backup, `restore`
// writes it back and catches the event index up, and `doctor` now reports
// the restored connection exactly as healthy as the original.
test("a restored vault keeps its enrolled connection usable and reports healthy", () => {
  const setup = tempVault();
  const imported = runCli(
    setup.env,
    "import",
    "markdown-folder",
    "--source",
    setup.notes,
    ...fixtureConsent(setup.root),
  );
  expect(imported.exitCode).toBe(0);

  const doctorBefore = runCli(setup.env, "doctor", "--vault", setup.vault);
  expect(doctorBefore.exitCode).toBe(0);
  expect(doctorBefore.stdout).toContain(`path=${setup.notes} state=present health=ok`);

  const outDir = join(setup.root, "export");
  const exported = runCli(setup.env, "export", "--out", outDir);
  expect(exported.exitCode).toBe(0);
  expect(exported.stdout).toContain("connections=1");
  // The bytes a `none`-auth connector's state holds (a local path here) are
  // never a credential, so export carries them next to the backup core wrote.
  expect(existsSync(join(outDir, "connections"))).toBe(true);

  const restored = join(setup.root, "restored");
  const restore = runCli(setup.env, "restore", "--from", outDir, "--into", restored);
  expect(restore.exitCode).toBe(0);

  const doctorAfter = runCli(setup.env, "doctor", "--vault", restored);
  // This is the finish line: before the fix, doctor reported this restored
  // vault as `state=missing health=misconfigured` with an `index-behind-ledger`
  // problem and exited 1. Both must be gone and doctor must exit 0.
  expect(doctorAfter.stdout).not.toContain("state=missing");
  expect(doctorAfter.stdout).not.toContain("index-behind-ledger");
  expect(doctorAfter.stdout).toContain(`path=${setup.notes} state=present health=ok`);
  expect(doctorAfter.stdout).toContain("status=ok");
  expect(doctorAfter.exitCode).toBe(0);
});

test("a restored connection whose source is genuinely gone still reports unhealthy", () => {
  const setup = tempVault();
  const imported = runCli(
    setup.env,
    "import",
    "markdown-folder",
    "--source",
    setup.notes,
    ...fixtureConsent(setup.root),
  );
  expect(imported.exitCode).toBe(0);

  const outDir = join(setup.root, "export");
  expect(runCli(setup.env, "export", "--out", outDir).exitCode).toBe(0);
  const restored = join(setup.root, "restored");
  expect(runCli(setup.env, "restore", "--from", outDir, "--into", restored).exitCode).toBe(0);

  // The path was restored, but the directory it names no longer exists — a
  // real loss, not an artifact of the restore. doctor must still catch it.
  rmSync(setup.notes, { recursive: true, force: true });

  const doctorAfter = runCli(setup.env, "doctor", "--vault", restored);
  expect(doctorAfter.stdout).toContain("health=misconfigured");
  expect(doctorAfter.stdout).toContain("status=failed");
  expect(doctorAfter.exitCode).toBe(1);
});
