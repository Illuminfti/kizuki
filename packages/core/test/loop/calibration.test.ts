import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertClaim } from "../../src/claims/store";
import { openLedger } from "../../src/ledger/db";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { persistRunReceipt } from "../../src/serve/receipts";
import { writeServeIntent } from "../../src/serve/intent";
import {
  CALIBRATION_BAND,
  emptyRunTotals,
} from "../../src/serve/types";
import { initVault } from "../../src/vault/init";
import { claimInput, putEvent } from "../claims/helpers";

const dirs: string[] = [];

function vault() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-loop-calibration-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  writeServeIntent(path, "opted-out");
  return { path, db };
}

function receipt(
  day: string,
  overrides: Partial<ReturnType<typeof emptyRunTotals>> & { run_id: string },
) {
  return {
    ...emptyRunTotals(),
    rail: "sync",
    started_at: `${day}T00:00:00Z`,
    finished_at: `${day}T00:00:01Z`,
    status: "ok" as const,
    stopped: null,
    ...overrides,
  };
}

async function storeMeasurable(
  db: ReturnType<typeof openLedger>,
  index: number,
  confidence: number,
) {
  const text = `synthetic loop person ${index} works at org-${index}.`;
  const first = putEvent(db, {
    source_record_id: `loop-a-${index}`,
    connector_id: "fixture-a",
    text,
  });
  const second = putEvent(db, {
    source_record_id: `loop-b-${index}`,
    connector_id: "fixture-b",
    text,
  });
  const result = await insertClaim(
    { db, now: () => "2026-08-27T00:00:00Z" },
    claimInput(first, {
      subject: `person:loop-${index}`,
      subjects: [`person:loop-${index}`],
      object: `org-${index}`,
      body: text,
      confidence,
      provenance: [first, second],
    }),
  );
  if (result.outcome !== "stored") throw new Error(`measurable claim ${index} was ${result.outcome}`);
  expect(result.claim.confidence).toBe(confidence);
  expect(result.claim.provenance).toHaveLength(2);
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("absent receipts leave calibration unmeasured rather than healthy-by-default", () => {
  const { path, db } = vault();
  const report = inspectServeDoctor(db, path, { now: "2026-08-28T00:00:00Z" });
  expect(report.calibration.write_rate).toBeNull();
  expect(report.calibration.dedup_rate).toBeNull();
  expect(report.calibration.confidence_spread).toBeNull();
  expect(report.calibration.failures).toEqual([]);
  db.close();
});

test("doctor fails when the seven-day write rate leaves the band", () => {
  const { path, db } = vault();
  for (let day = 1; day <= 7; day += 1) {
    persistRunReceipt(
      db,
      path,
      receipt(`2026-08-2${day}`, {
        run_id: `01JBCALIBHIGH000000000000${day}`,
        claims_extracted: 10,
        claims_written: 10,
      }),
    );
  }
  const report = inspectServeDoctor(db, path, { now: "2026-08-28T00:00:00Z" });
  expect(report.calibration.write_rate).toBeCloseTo(1);
  expect(report.ok).toBe(false);
  expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(true);
  expect(report.calibration.failures[0]).toContain(`${CALIBRATION_BAND.min}`);
  expect(report.calibration.failures[0]).toContain(`${CALIBRATION_BAND.max}`);
  db.close();
});

test("doctor fails when confidence has no spread across the corpus", async () => {
  const { path, db } = vault();
  persistRunReceipt(
    db,
    path,
    receipt("2026-08-27", {
      run_id: "01JBCALIBFLAT0000000000001",
      claims_extracted: 10,
      claims_written: 4,
      claims_deduped: 3,
    }),
  );
  for (let index = 0; index < 8; index += 1) {
    await storeMeasurable(db, index, 0.9);
  }
  const report = inspectServeDoctor(db, path, { now: "2026-08-28T00:00:00Z" });
  expect(report.ok).toBe(false);
  expect(report.calibration.failures).toContain("confidence_not_produced");
  expect(report.failures).toContain("confidence_not_produced");
  expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(false);
  db.close();
});

test("in-band writes with spread confidence stay unfailed", async () => {
  const { path, db } = vault();
  persistRunReceipt(
    db,
    path,
    receipt("2026-08-27", {
      run_id: "01JBCALIBOK000000000000001",
      claims_extracted: 10,
      claims_written: 4,
      claims_deduped: 3,
    }),
  );
  for (let index = 0; index < 8; index += 1) {
    await storeMeasurable(db, index, 0.2 + index * 0.08);
  }
  const report = inspectServeDoctor(db, path, { now: "2026-08-28T00:00:00Z" });
  expect(report.calibration.write_rate).toBeCloseTo(0.4);
  expect(report.calibration.failures).toEqual([]);
  expect(report.failures).not.toContain("confidence_not_produced");
  db.close();
});

test("a second receipt against an in-window corpus still fails the write-rate ceiling", async () => {
  const { path, db } = vault();
  for (let index = 0; index < 8; index += 1) {
    await storeMeasurable(db, index, 0.2 + index * 0.08);
  }
  persistRunReceipt(
    db,
    path,
    receipt("2026-08-27", {
      run_id: "01JBCALIBSECA0000000000001",
      claims_extracted: 8,
      claims_written: 8,
    }),
  );
  persistRunReceipt(
    db,
    path,
    receipt("2026-08-28", {
      run_id: "01JBCALIBSECB0000000000001",
      claims_extracted: 10,
      claims_written: 10,
      claims_deduped: 0,
    }),
  );
  const report = inspectServeDoctor(db, path, { now: "2026-08-28T00:00:00Z" });
  expect(report.calibration.write_rate).toBeCloseTo(1);
  expect(report.ok).toBe(false);
  expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(true);
  expect(report.calibration.failures[0]).toContain(`${CALIBRATION_BAND.min}`);
  expect(report.calibration.failures[0]).toContain(`${CALIBRATION_BAND.max}`);
  expect(report.failures).not.toContain("confidence_not_produced");
  db.close();
});
