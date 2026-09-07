import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  test("init seals zero and every close reseals the accepted total", () => {
    const setup = tempVault();
    expect(readMark(setup.vault)).toBe("0\n");
    seeded();
    const doctor = runCli(setup.env, "doctor");
    expect(doctor.exitCode).toBe(0);
    expect(readMark(setup.vault)).toBe("0\n");
  });

  test("a ledger short of its mark fails closed instead of printing events=0", () => {
    const setup = seeded();
    parkLedger(setup);
    const started = Date.now();
    const doctor = runCli(setup.env, "doctor");
    expect(doctor.exitCode).toBe(1);
    expect(doctor.stderr).toContain("vault ledger not ready: 0 of 3 sealed events readable");
    expect(doctor.stderr).toContain("Do not run kizuki init");
    expect(doctor.stdout).not.toContain("events=");
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
    // A refused read never lowers the bar it was refused against.
    expect(readMark(setup.vault)).toBe("3\n");
  });

  test("a store that lands inside the deadline is read, not refused", async () => {
    const setup = seeded();
    const parked = parkLedger(setup);
    const pending = runCliAsync(setup.env, "doctor");
    await Bun.sleep(700);
    parked.restore();
    const doctor = await pending;
    // Connection health probes share doctor's exit code and can time out under
    // load; the gate's verdict is the empty stderr and the count it printed.
    expect(doctor.stderr).toBe("");
    expect(doctor.stdout).toContain("events=3");
    expect(readMark(setup.vault)).toBe("3\n");
  });

  test("an absent, stale-low, or unreadable mark is tolerated and resealed", () => {
    const setup = seeded();
    for (const stale of [null, "1\n", "three\n", "-1\n"]) {
      if (stale === null) rmSync(markPath(setup.vault));
      else writeFileSync(markPath(setup.vault), stale);
      const doctor = runCli(setup.env, "doctor");
      expect(doctor.stderr).toBe("");
      expect(doctor.stdout).toContain("events=3");
      expect(readMark(setup.vault)).toBe("3\n");
    }
  });

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
