import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSince } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers, fixtureConsent } from "../helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

interface DoctorEnvelope {
  status: string;
  degraded: string[];
  data: {
    ok: boolean;
    problems: { page: string; error: string }[];
    index: { fresh: boolean; degraded: string[]; erased_behind: number };
  };
}

function importedVault(): { setup: ReturnType<typeof tempVault>; eventId: string } {
  const setup = tempVault();
  writeFileSync(join(setup.notes, "acme.md"), "Grace runs partnerships at Acme.\n");
  const imported = runCli(
    setup.env,
    "import",
    "markdown-folder",
    "--source",
    setup.notes,
    ...fixtureConsent(setup.root),
  );
  expect(imported.exitCode).toBe(0);

  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const target = readSince(db, null, 20).events.find(
    (event) => event.source_record_id === "acme.md",
  );
  db.close();
  if (target === undefined) throw new Error("acme.md was not imported");
  return { setup, eventId: target.event_id };
}

test("doctor stays green after a purge shrinks the ledger below the stored cursor", () => {
  const { setup, eventId } = importedVault();

  const before = JSON.parse(runCli(setup.env, "doctor", "--json").stdout) as DoctorEnvelope;
  expect(before.data.ok).toBe(true);

  const purged = runCli(
    setup.env,
    "purge",
    "--event",
    eventId,
    "--reason",
    "source deleted",
    "--confirm",
  );
  expect(purged.exitCode).toBe(0);
  expect(purged.stdout).toContain("purged 1 event");

  const doctor = runCli(setup.env, "doctor", "--json");
  expect(doctor.exitCode).toBe(0);
  const after = JSON.parse(doctor.stdout) as DoctorEnvelope;
  expect(after.status).toBe("ok");
  expect(after.data.ok).toBe(true);
  expect(after.data.problems).toEqual([]);
  // The reading stays visible without failing the vault.
  expect(after.data.index.fresh).toBe(false);
  expect(after.data.index.degraded).toContain("index-behind-ledger");
  expect(after.data.index.erased_behind).toBe(1);
  expect(after.degraded.join(" ")).toContain("index-behind-ledger accounted for by 1 erased event");

  const human = runCli(setup.env, "doctor");
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain("status=ok");
  expect(human.stdout).toContain("index index-behind-ledger accounted for by 1 erased event");
});

test("doctor still fails and points at rebuild when the cursor is behind without erasure", () => {
  const { setup } = importedVault();
  const cursorPath = join(setup.vault, ".kizuki", "index-cursor.json");
  const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as {
    events_seen: number;
  };
  writeFileSync(
    cursorPath,
    `${JSON.stringify({ ...cursor, events_seen: cursor.events_seen + 1 })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const doctor = runCli(setup.env, "doctor", "--json");
  expect(doctor.exitCode).toBe(1);
  const report = JSON.parse(doctor.stdout) as DoctorEnvelope;
  expect(report.data.ok).toBe(false);
  expect(report.data.problems).toContainEqual({ page: "-", error: "index-behind-ledger" });
  expect(report.data.index.erased_behind).toBe(0);

  const human = runCli(setup.env, "doctor");
  expect(human.exitCode).toBe(1);
  expect(human.stdout).toContain("next: kizuki rebuild --confirm");
  expect(human.stdout).not.toContain('next: kizuki tell');
});
