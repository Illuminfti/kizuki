import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SINGLE_SOURCE_CAP } from "../../src/claims/authority";
import { insertClaim } from "../../src/claims/store";
import { openLedger } from "../../src/ledger/db";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { writeServeIntent } from "../../src/serve/intent";
import { persistRunReceipt } from "../../src/serve/receipts";
import { emptyRunTotals } from "../../src/serve/types";
import { initVault } from "../../src/vault/init";
import { claimInput, putEvent } from "../claims/helpers";

/**
 * Issue #473: a stranger's day-one vault runs the loop correctly and doctor
 * still reports `error` on the keep-rate band alone. The band is a
 * steady-state control; a first fill and an undersized sample are not
 * evidence of drift, and doctor must say which check it skipped.
 */

const dirs: string[] = [];
const NOW = "2026-08-28T00:00:00.000Z";
const RUN_STARTED_AT = "2026-08-27T00:00:00Z";
/** Asserted after the run started: the corpus this run created. */
const IN_WINDOW = "2026-08-27T00:00:01.000Z";
/** Asserted before the run started: a corpus the run inherited. */
const PRIOR = "2026-08-01T00:00:00.000Z";
/** A stranger's day one has exactly one connector enrolled. */
const CONNECTOR = "fixture-markdown-folder";

function vault() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-fresh-vault-doctor-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  writeServeIntent(path, "opted-out");
  return { path, db };
}

function backfill(
  overrides: Partial<ReturnType<typeof emptyRunTotals>> & { run_id: string },
) {
  return {
    ...emptyRunTotals(),
    rail: "sync",
    started_at: RUN_STARTED_AT,
    finished_at: "2026-08-27T00:01:00Z",
    status: "ok" as const,
    stopped: null,
    ...overrides,
  };
}

/** One connector, one event, no corroboration: the day-one claim shape. */
async function storeSingleSource(
  db: ReturnType<typeof openLedger>,
  index: number,
  at: string,
) {
  const text = `synthetic note ${index} records org-${index} as the owner of project ${index}.`;
  const eventId = putEvent(db, {
    source_record_id: `fresh-${index}`,
    connector_id: CONNECTOR,
    text,
  });
  const result = await insertClaim(
    { db, now: () => at },
    claimInput(eventId, {
      subject: `person:fresh-${index}`,
      subjects: [`person:fresh-${index}`],
      object: `org-${index}`,
      body: text,
      confidence: 0.5,
    }),
  );
  if (result.outcome !== "stored") throw new Error(`fresh claim ${index} was ${result.outcome}`);
  expect(result.claim.authority).toBe("model_inference");
  expect(result.claim.confidence).toBe(SINGLE_SOURCE_CAP);
  expect(result.claim.corroboration).toBe(1);
  expect(result.claim.provenance).toEqual([eventId]);
}

/** Two connectors agree: confidence escapes the single-source cap. */
async function storeCorroborated(
  db: ReturnType<typeof openLedger>,
  index: number,
  at: string,
  confidence: number,
) {
  const text = `synthetic mature person ${index} works at org-${index}.`;
  const first = putEvent(db, {
    source_record_id: `mature-a-${index}`,
    connector_id: "fixture-a",
    text,
  });
  const second = putEvent(db, {
    source_record_id: `mature-b-${index}`,
    connector_id: "fixture-b",
    text,
  });
  const result = await insertClaim(
    { db, now: () => at },
    claimInput(first, {
      subject: `person:mature-${index}`,
      subjects: [`person:mature-${index}`],
      object: `org-${index}`,
      body: text,
      confidence,
      provenance: [first, second],
    }),
  );
  if (result.outcome !== "stored") throw new Error(`mature claim ${index} was ${result.outcome}`);
  expect(result.claim.confidence).toBe(confidence);
  expect(result.claim.provenance).toHaveLength(2);
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("doctor on a freshly initialised single-connector vault", () => {
  test("a first backfill that admits every draft is ok and says the band was skipped", async () => {
    const { path, db } = vault();
    try {
      for (let index = 0; index < 18; index += 1) await storeSingleSource(db, index, IN_WINDOW);
      persistRunReceipt(
        db,
        path,
        backfill({
          run_id: "01JBFRESHVAULTALLKEPT00001",
          claims_extracted: 18,
          claims_written: 18,
        }),
      );
      const report = inspectServeDoctor(db, path, { now: NOW });
      // The metric stays truthful; only the verdict is withheld.
      expect(report.calibration.write_rate).toBeCloseTo(1);
      expect(report.calibration.bands_enforced).toBe(false);
      expect(report.calibration.bands_reason).toBe("initial-capture");
      expect(report.calibration.failures).toEqual([]);
      expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(false);
      expect(report.failures).not.toContain("confidence_not_produced");
      expect(report.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a first backfill that admits few drafts is ok and says the band was skipped", async () => {
    const { path, db } = vault();
    try {
      await storeSingleSource(db, 0, IN_WINDOW);
      persistRunReceipt(
        db,
        path,
        backfill({
          run_id: "01JBFRESHVAULTFEWKEPT00001",
          claims_extracted: 20,
          claims_written: 1,
          claims_deduped: 19,
        }),
      );
      const report = inspectServeDoctor(db, path, { now: NOW });
      expect(report.calibration.write_rate).toBeCloseTo(0.05);
      expect(report.calibration.bands_enforced).toBe(false);
      expect(report.calibration.bands_reason).toBe("initial-capture");
      expect(report.calibration.failures).toEqual([]);
      expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(false);
      expect(report.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a steady-state vault at the same low keep rate still fails the lower bound", async () => {
    const { path, db } = vault();
    try {
      for (let index = 0; index < 8; index += 1) {
        await storeCorroborated(db, index, PRIOR, 0.2 + index * 0.08);
      }
      persistRunReceipt(
        db,
        path,
        backfill({
          run_id: "01JBSTEADYLOWKEEPRATE00001",
          claims_extracted: 20,
          claims_written: 1,
          claims_deduped: 19,
        }),
      );
      const report = inspectServeDoctor(db, path, { now: NOW });
      expect(report.calibration.write_rate).toBeCloseTo(0.05);
      expect(report.calibration.bands_enforced).toBe(true);
      expect(report.calibration.bands_reason).toBeNull();
      expect(report.calibration.failures.some((item) => item.startsWith("write_rate "))).toBe(true);
      expect(report.ok).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a steady-state vault above the ceiling still fails the upper bound", async () => {
    const { path, db } = vault();
    try {
      for (let index = 0; index < 8; index += 1) {
        await storeCorroborated(db, index, PRIOR, 0.2 + index * 0.08);
      }
      persistRunReceipt(
        db,
        path,
        backfill({
          run_id: "01JBSTEADYHIGHKEEPRATE0001",
          claims_extracted: 20,
          claims_written: 19,
        }),
      );
      const report = inspectServeDoctor(db, path, { now: NOW });
      expect(report.calibration.write_rate).toBeCloseTo(0.95);
      expect(report.calibration.bands_enforced).toBe(true);
      expect(report.calibration.failures.some((item) => item.startsWith("write_rate "))).toBe(true);
      expect(report.ok).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a sample below the floor is reported as unenforced, not as a failure", async () => {
    const { path, db } = vault();
    try {
      for (let index = 0; index < 8; index += 1) {
        await storeCorroborated(db, index, PRIOR, 0.2 + index * 0.08);
      }
      persistRunReceipt(
        db,
        path,
        backfill({
          run_id: "01JBUNDERSAMPLEKEEPRATE001",
          claims_extracted: 4,
          claims_written: 0,
          claims_deduped: 4,
        }),
      );
      const report = inspectServeDoctor(db, path, { now: NOW });
      // The same 0 rate on an adequate sample fails; four drafts prove nothing.
      expect(report.calibration.write_rate).toBeCloseTo(0);
      expect(report.calibration.bands_enforced).toBe(false);
      expect(report.calibration.bands_reason).toBe("insufficient-sample");
      expect(report.calibration.failures).toEqual([]);
      expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(false);
    } finally {
      db.close();
    }
  });

  test("the same keep rate at or above the floor does fail", async () => {
    const { path, db } = vault();
    try {
      for (let index = 0; index < 8; index += 1) {
        await storeCorroborated(db, index, PRIOR, 0.2 + index * 0.08);
      }
      persistRunReceipt(
        db,
        path,
        backfill({
          run_id: "01JBATSAMPLEFLOORKEEPRATE1",
          claims_extracted: 8,
          claims_written: 0,
          claims_deduped: 8,
        }),
      );
      const report = inspectServeDoctor(db, path, { now: NOW });
      expect(report.calibration.write_rate).toBeCloseTo(0);
      expect(report.calibration.bands_enforced).toBe(true);
      expect(report.calibration.failures.some((item) => item.startsWith("write_rate "))).toBe(true);
    } finally {
      db.close();
    }
  });

  test("eight uncapped rows with no spread still fire confidence_not_produced", async () => {
    const { path, db } = vault();
    try {
      for (let index = 0; index < 8; index += 1) await storeCorroborated(db, index, PRIOR, 0.9);
      persistRunReceipt(
        db,
        path,
        backfill({
          run_id: "01JBUNCAPPEDFLATSPREAD0001",
          claims_extracted: 10,
          claims_written: 4,
          claims_deduped: 3,
        }),
      );
      const report = inspectServeDoctor(db, path, { now: NOW });
      expect(report.calibration.failures).toContain("confidence_not_produced");
      expect(report.failures).toContain("confidence_not_produced");
      expect(report.ok).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a single-source corpus capped at the policy ceiling is not a flat producer", async () => {
    const { path, db } = vault();
    try {
      for (let index = 0; index < 8; index += 1) await storeSingleSource(db, index, PRIOR);
      persistRunReceipt(
        db,
        path,
        backfill({
          run_id: "01JBSINGLESOURCECAPPED0001",
          claims_extracted: 10,
          claims_written: 4,
          claims_deduped: 3,
        }),
      );
      const report = inspectServeDoctor(db, path, { now: NOW });
      expect(report.calibration.confidence_spread).toBeCloseTo(0);
      expect(report.calibration.failures).toEqual([]);
      expect(report.failures).not.toContain("confidence_not_produced");
      expect(report.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  test("an unparseable receipt clock is named, not silently judged as steady state", async () => {
    const { path, db } = vault();
    try {
      for (let index = 0; index < 18; index += 1) await storeSingleSource(db, index, IN_WINDOW);
      persistRunReceipt(db, path, {
        ...backfill({
          run_id: "01JBUNPARSEABLECLOCK000001",
          claims_extracted: 18,
          claims_written: 18,
        }),
        started_at: "not-a-clock",
      });
      const report = inspectServeDoctor(db, path, { now: NOW });
      expect(report.calibration.write_rate).toBeCloseTo(1);
      expect(report.calibration.bands_enforced).toBe(false);
      expect(report.calibration.bands_reason).toBe("receipt-clock-unparseable");
      expect(report.calibration.failures).toContain("calibration_clock_unreadable");
      expect(report.calibration.failures.some((item) => item.startsWith("write_rate "))).toBe(false);
      expect(report.failures).toContain("calibration_clock_unreadable");
      expect(report.ok).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a vault with no receipts reports no band and no failure", () => {
    const { path, db } = vault();
    try {
      const report = inspectServeDoctor(db, path, { now: NOW });
      expect(report.calibration.write_rate).toBeNull();
      expect(report.calibration.bands_enforced).toBe(false);
      expect(report.calibration.bands_reason).toBe("no-receipts");
      expect(report.calibration.failures).toEqual([]);
    } finally {
      db.close();
    }
  });
});
