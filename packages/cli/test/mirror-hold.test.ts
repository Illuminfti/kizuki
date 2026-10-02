import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listConnections, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(120_000);

const h = createHelpers();
afterEach(h.cleanup);

const name = (index: number): string => `n${String(index).padStart(3, "0")}.md`;

function enrolledFolder(count: number) {
  const setup = h.tempVault();
  const notes = join(setup.root, "mirror");
  mkdirSync(notes);
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(notes, name(index)), `synthetic note ${index}\n`);
  }
  expect(
    h.runCli(
      setup.env,
      "connect",
      "markdown-folder",
      "--source",
      notes,
      "--vault",
      setup.vault,
    ).exitCode,
  ).toBe(0);
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    const key = listConnections(db)[0]!.source_key;
    setSourceGrant(db, {
      source_key: key,
      expected_revision: 0,
      operation_id: "synthetic-folder-grant",
      policy: {
        purposes: ["capture", "recall"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        sensitivity_floor: "private",
      },
    });
    return { ...setup, notes, key };
  } finally {
    db.close();
  }
}

function json(result: { stdout: string }): any {
  return JSON.parse(result.stdout);
}

test("a sync that would empty the source holds, says so everywhere, and one confirmation releases it", () => {
  const setup = enrolledFolder(50);
  const sync = (...extra: string[]) =>
    h.runCli(
      setup.env,
      "sync",
      "markdown-folder",
      "--vault",
      setup.vault,
      ...extra,
    );
  expect(sync().stdout).toContain("events_stored=50");
  expect(sync().stdout).toContain("events_stored=0");

  // The volume is replaced by a tree holding 3 of the 50 notes.
  for (let index = 3; index < 50; index += 1)
    rmSync(join(setup.notes, name(index)));
  const held = sync();
  expect(held.exitCode).toBe(1);
  expect(held.stderr).toContain("error: mass_withdrawal_held: 47 of 50");
  expect(held.stderr).toContain("withdrew none");
  expect(held.stderr).toContain(
    `sync markdown-folder --source ${setup.key} --confirm-withdrawals 47`,
  );

  // connect status, per source and overall, and doctor all carry the typed state.
  const overall = json(
    h.runCli(setup.env, "connect", "status", "--json", "--vault", setup.vault),
  );
  expect(overall.data.connections[0].hold).toEqual({
    state: "mass_withdrawal_held",
    withdrawn: 47,
    total: 50,
  });
  const table = h.runCli(
    setup.env,
    "connect",
    "status",
    "--vault",
    setup.vault,
  );
  expect(table.stdout).toContain(
    "mass_withdrawal_held: this sync would withdraw 47 of 50 records",
  );
  const single = json(
    h.runCli(
      setup.env,
      "connect",
      "status",
      "--source",
      setup.key,
      "--json",
      "--vault",
      setup.vault,
    ),
  );
  expect(single.data.hold).toEqual({
    state: "mass_withdrawal_held",
    withdrawn: 47,
    total: 50,
  });
  const doctor = h.runCli(
    setup.env,
    "doctor",
    "--json",
    "--vault",
    setup.vault,
  );
  expect(doctor.exitCode).toBe(1);
  const report = json(doctor).data;
  expect(report.ok).toBe(false);
  expect(report.connections[0].hold).toEqual({
    state: "mass_withdrawal_held",
    withdrawn: 47,
    total: 50,
  });
  const doctorText = h.runCli(setup.env, "doctor", "--vault", setup.vault);
  expect(doctorText.stdout).toContain("source-hold kizuki.markdown-folder");
  expect(doctorText.stdout).toContain(`--confirm-withdrawals 47`);

  // Nothing was withdrawn, and a repeat holds the same way.
  expect(sync().stderr).toContain("mass_withdrawal_held: 47 of 50");

  // Restoring the tree clears the hold without an event.
  for (let index = 3; index < 50; index += 1) {
    writeFileSync(join(setup.notes, name(index)), `synthetic note ${index}\n`);
  }
  const restored = sync();
  expect(restored.exitCode).toBe(0);
  expect(restored.stdout).toContain("events_stored=0");
  expect(
    json(
      h.runCli(
        setup.env,
        "connect",
        "status",
        "--json",
        "--vault",
        setup.vault,
      ),
    ).data.connections[0].hold,
  ).toBeNull();

  // A real loss: the confirmation names the count it releases.
  for (let index = 3; index < 50; index += 1)
    rmSync(join(setup.notes, name(index)));
  expect(sync().exitCode).toBe(1);
  const wrong = h.runCli(
    setup.env,
    "sync",
    "markdown-folder",
    "--source",
    setup.key,
    "--confirm-withdrawals",
    "46",
    "--vault",
    setup.vault,
  );
  expect(wrong.exitCode).toBe(1);
  expect(wrong.stderr).toContain("mass_withdrawal_held: 47 of 50");
  const released = h.runCli(
    setup.env,
    "sync",
    "markdown-folder",
    "--source",
    setup.key,
    "--confirm-withdrawals",
    "47",
    "--vault",
    setup.vault,
  );
  expect(released.exitCode).toBe(0);
  expect(released.stdout).toContain("events_stored=47");
  expect(released.stdout).toContain("withdrawn=");
  expect(
    json(
      h.runCli(
        setup.env,
        "connect",
        "status",
        "--json",
        "--vault",
        setup.vault,
      ),
    ).data.connections[0].hold,
  ).toBeNull();
  // The release was for one run: the next pass has nothing left to withdraw.
  expect(sync().stdout).toContain("events_stored=0");
});

test("--confirm-withdrawals needs a mirror source and a positive whole number", () => {
  const setup = enrolledFolder(2);
  for (const args of [
    ["sync", "markdown-folder", "--confirm-withdrawals", "5"],
    [
      "sync",
      "markdown-folder",
      "--source",
      setup.key,
      "--confirm-withdrawals",
      "0",
    ],
    [
      "sync",
      "markdown-folder",
      "--source",
      setup.key,
      "--confirm-withdrawals",
      "-3",
    ],
    [
      "sync",
      "markdown-folder",
      "--source",
      setup.key,
      "--confirm-withdrawals",
      "1.5",
    ],
    [
      "sync",
      "markdown-folder",
      "--source",
      setup.key,
      "--confirm-withdrawals",
      "many",
    ],
  ]) {
    const result = h.runCli(setup.env, ...args, "--vault", setup.vault);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--confirm-withdrawals");
  }
});
