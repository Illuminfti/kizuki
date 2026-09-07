import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers, fixtureConsent } from "../helpers";

const { cleanup, runCli, runCliAsync, tempDir, tempVault } = createHelpers();
afterEach(cleanup);

const SIDECARS = ["", "-wal", "-shm"] as const;
const ledgerPath = (vault: string): string => join(vault, ".kizuki", "kizuki.db");
const markPath = (vault: string): string => join(vault, ".kizuki", "ledger-mark");
const readMark = (vault: string): string => readFileSync(markPath(vault), "utf8");

type Seeded = ReturnType<typeof tempVault>;

function seeded(): Seeded {
  const setup = tempVault();
  const imported = runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root));
  expect(imported.exitCode).toBe(0);
  expect(imported.stderr).toBe("");
  expect(imported.stdout).toStartWith("events_stored=3 ");
  expect(readMark(setup.vault)).toBe("3\n");
  return setup;
}

/** Issue #454, hypothesis 2: same path, same vault-id, a ledger that holds nothing. */
function parkLedger(setup: Seeded): { restore(): void } {
  const parked = join(tempDir("kizuki-parked-"), "ledger");
  mkdirSync(parked);
  for (const suffix of SIDECARS) {
    const file = `${ledgerPath(setup.vault)}${suffix}`;
    if (existsSync(file)) renameSync(file, join(parked, `kizuki.db${suffix}`));
  }
  const empty = tempVault();
  copyFileSync(ledgerPath(empty.vault), ledgerPath(setup.vault));
  chmodSync(ledgerPath(setup.vault), 0o600);
  return {
    restore() {
      for (const suffix of SIDECARS) {
        const file = `${ledgerPath(setup.vault)}${suffix}`;
        rmSync(file, { force: true });
        const kept = join(parked, `kizuki.db${suffix}`);
        if (existsSync(kept)) renameSync(kept, file);
      }
    },
  };
}

describe("ledger readiness mark", () => {
  test("init and import writers seal while successful reads leave the mark unchanged", () => {
    const setup = tempVault();
    expect(readMark(setup.vault)).toBe("0\n");
    seeded();
    const doctor = runCli(setup.env, "doctor");
    expect(doctor.exitCode).toBe(0);
    expect(readMark(setup.vault)).toBe("0\n");
    const query = runCli(setup.env, "query", "ada", "--scope", "ledger", "--json");
    expect(query.exitCode).toBe(0);
    expect(readMark(setup.vault)).toBe("0\n");
  });

  test.each(["doctor", "query"])("%s refuses a short ledger without printing a successful count", command => {
    const setup = seeded();
    parkLedger(setup);
    const started = Date.now();
    const doctor = command === "doctor" ? runCli(setup.env, "doctor") : runCli(setup.env, "query", "ada", "--scope", "ledger", "--json");
    expect(doctor.exitCode).toBe(1);
    expect(doctor.stderr).toContain("vault ledger not ready");
    expect(doctor.stderr).toContain("Do not run kizuki init");
    expect(doctor.stdout).not.toContain("events=");
    expect(doctor.stdout).not.toContain("\"hits\"");
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
    // A refused read never lowers the bar it was refused against.
    expect(readMark(setup.vault)).toBe("3\n");
  }, 15_000);

  test("a store that lands inside the deadline is read, not refused", async () => {
    const setup = seeded();
    const parked = parkLedger(setup);
    const pending = runCliAsync(setup.env, "doctor");
    await Bun.sleep(700);
    parked.restore();
    const doctor = await pending;
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stderr).toBe("");
    expect(doctor.stdout).toContain("events=3");
    expect(readMark(setup.vault)).toBe("3\n");
  });

  test("doctor and query tolerate legacy unsealed marks without creating, repairing or resealing", () => {
    const setup = seeded();
    for (const stale of [null, "1\n", "three\n", "-1\n"]) {
      if (stale === null) rmSync(markPath(setup.vault));
      else writeFileSync(markPath(setup.vault), stale, { mode: 0o600 });
      for (const command of ["doctor", "query"]) {
        const before = existsSync(markPath(setup.vault)) ? statSync(markPath(setup.vault), { bigint: true }) : null;
        const result = command === "doctor" ? runCli(setup.env, "doctor") : runCli(setup.env, "query", "ada", "--scope", "ledger", "--json");
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        if (command === "doctor") expect(result.stdout).toContain("events=3");
        else expect(JSON.parse(result.stdout).status).toBe("ok");
        if (stale === null) expect(existsSync(markPath(setup.vault))).toBe(false);
        else {
          expect(readMark(setup.vault)).toBe(stale);
          const after = statSync(markPath(setup.vault), { bigint: true });
          expect(after.ino).toBe(before!.ino);
          expect(after.mtimeNs).toBe(before!.mtimeNs);
        }
      }
    }
  }, 15_000);

  test.each(["oversized", "nonprivate", "symlink"])("reads refuse %s marks before normal output", kind => {
    const setup = seeded();
    const outside = join(setup.root, "outside-mark");
    if (kind === "symlink") {
      writeFileSync(outside, "3\n", { mode: 0o600 });
      rmSync(markPath(setup.vault));
      symlinkSync(outside, markPath(setup.vault));
    } else if (kind === "oversized") writeFileSync(markPath(setup.vault), "1".repeat(18));
    else chmodSync(markPath(setup.vault), 0o644);
    for (const command of ["doctor", "query"]) {
      const result = command === "doctor" ? runCli(setup.env, "doctor") : runCli(setup.env, "query", "ada", "--scope", "ledger", "--json");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("ledger");
      expect(result.stdout).not.toContain("events=");
      expect(result.stdout).not.toContain("\"hits\"");
    }
    if (kind === "symlink") expect(readFileSync(outside, "utf8")).toBe("3\n");
  });

  test("explicit init refuses a high floor before changing the short ledger or service intent", () => {
    const setup = seeded();
    parkLedger(setup);
    const control = join(setup.vault, ".kizuki");
    const beforeNames = readdirSync(control).sort();
    const beforeLedger = readFileSync(ledgerPath(setup.vault));
    const intent = join(control, "serve-intent");
    const beforeIntent = existsSync(intent) ? readFileSync(intent) : null;
    const result = runCli(setup.env, "init", setup.vault, "--no-service", "--no-default");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("vault ledger not ready");
    expect(result.stdout).not.toContain("events=");
    expect(readMark(setup.vault)).toBe("3\n");
    expect(readFileSync(ledgerPath(setup.vault))).toEqual(beforeLedger);
    expect(readdirSync(control).sort()).toEqual(beforeNames);
    expect(existsSync(intent) ? readFileSync(intent) : null).toEqual(beforeIntent);
  }, 15_000);

  test("purge keeps the mark monotonic so a receipted deletion never trips the gate", () => {
    const setup = seeded();
    const purged = runCli(setup.env, "purge", "--connector", "kizuki.markdown-folder", "--record", "ada.md", "--reason", "source deleted");
    expect(purged.exitCode).toBe(0);
    expect(readMark(setup.vault)).toBe("3\n");
    const doctor = runCli(setup.env, "doctor");
    expect(doctor.stderr).not.toContain("vault ledger not ready");
    expect(doctor.stdout).toContain("events=2");
    expect(readMark(setup.vault)).toBe("3\n");
  });
});
