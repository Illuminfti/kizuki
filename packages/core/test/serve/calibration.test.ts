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
import { CALIBRATION_BAND, emptyRunTotals } from "../../src/serve/types";
import { initVault } from "../../src/vault/init";
import { claimInput, putEvent } from "../claims/helpers";

const dirs: string[] = [];
const NOW = "2026-08-28T00:00:00.000Z";
const IN_WINDOW = "2026-08-27T00:00:00.000Z";
const PRIOR = "2026-08-01T00:00:00.000Z";
const MODEL = "kizuki.llm.openai-compatible:synthetic@local";

function vault() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-serve-calibration-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  writeServeIntent(path, "opted-out");
  return { path, db };
}

function receipt(
  day: string,
  overrides: Partial<ReturnType<typeof emptyRunTotals>> & {
    run_id: string;
    status?: "ok" | "degraded";
  },
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

async function storeNovel(db: ReturnType<typeof openLedger>, index: number, at: string) {
  const text = `synthetic person ${index} works at org-${index}.`;
  const eventId = putEvent(db, { source_record_id: `novel-${index}`, text });
  const result = await insertClaim(
    { db, now: () => at },
    claimInput(eventId, {
      subject: `person:novel-${index}`,
      subjects: [`person:novel-${index}`],
      object: `org-${index}`,
      body: text,
      confidence: 0.9,
    }),
  );
  if (result.outcome !== "stored") throw new Error(`novel claim ${index} was ${result.outcome}`);
  expect(result.claim.authority).toBe("model_inference");
  expect(result.claim.confidence).toBe(SINGLE_SOURCE_CAP);
  expect(result.claim.provenance).toEqual([eventId]);
}

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

describe("doctor calibration", () => {
  test("a fresh vault of novel claims is not a broken model", async () => {
    const { path, db } = vault();
    for (let index = 0; index < 8; index += 1) await storeNovel(db, index, IN_WINDOW);
    persistRunReceipt(
      db,
      path,
      receipt("2026-08-27", {
        run_id: "01JBFRESHNOVEL000000000001",
        claims_extracted: 8,
        claims_written: 8,
      }),
    );
    const report = inspectServeDoctor(db, path, { now: NOW });
    expect(report.calibration.write_rate).toBeCloseTo(1);
    expect(report.calibration.confidence_spread).toBeCloseTo(0);
    expect(report.calibration.failures).toEqual([]);
    expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(false);
    expect(report.failures).not.toContain("confidence_not_produced");
    expect(report.ok).toBe(true);
    db.close();
  });

  test("policy-capped single-source confidence is not confidence_not_produced", async () => {
    const { path, db } = vault();
    for (let index = 0; index < 8; index += 1) await storeNovel(db, index, IN_WINDOW);
    persistRunReceipt(
      db,
      path,
      receipt("2026-08-27", {
        run_id: "01JBPOLICYCAP0000000000001",
        claims_extracted: 10,
        claims_written: 4,
        claims_deduped: 3,
      }),
    );
    const report = inspectServeDoctor(db, path, { now: NOW });
    expect(report.calibration.write_rate).toBeCloseTo(0.4);
    expect(report.calibration.confidence_spread).toBeCloseTo(0);
    expect(report.calibration.failures).toEqual([]);
    expect(report.failures).not.toContain("confidence_not_produced");
    expect(report.ok).toBe(true);
    db.close();
  });

  test("a mature vault still fails an out-of-band write rate", async () => {
    const { path, db } = vault();
    for (let index = 0; index < 8; index += 1) {
      await storeCorroborated(db, index, PRIOR, 0.2 + index * 0.08);
    }
    for (let day = 1; day <= 7; day += 1) {
      persistRunReceipt(
        db,
        path,
        receipt(`2026-08-2${day}`, {
          run_id: `01JBMATUREWRT000000000000${day}`,
          claims_extracted: 10,
          claims_written: 10,
        }),
      );
    }
    const report = inspectServeDoctor(db, path, { now: NOW });
    expect(report.calibration.write_rate).toBeCloseTo(1);
    expect(report.ok).toBe(false);
    expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(true);
    expect(report.calibration.failures[0]).toContain(`${CALIBRATION_BAND.min}`);
    expect(report.calibration.failures[0]).toContain(`${CALIBRATION_BAND.max}`);
    expect(report.failures).not.toContain("confidence_not_produced");
    db.close();
  });

  test("a mature vault still fails a rubber-stamped confidence corpus", async () => {
    const { path, db } = vault();
    for (let index = 0; index < 8; index += 1) {
      await storeCorroborated(db, index, PRIOR, 0.9);
    }
    persistRunReceipt(
      db,
      path,
      receipt("2026-08-27", {
        run_id: "01JBMATURECONF000000000001",
        claims_extracted: 10,
        claims_written: 4,
        claims_deduped: 3,
      }),
    );
    const report = inspectServeDoctor(db, path, { now: NOW });
    expect(report.ok).toBe(false);
    expect(report.calibration.failures).toContain("confidence_not_produced");
    expect(report.failures).toContain("confidence_not_produced");
    expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(false);
    db.close();
  });

  test("model unavailability is not a calibration failure", async () => {
    const { path, db } = vault();
    for (let index = 0; index < 8; index += 1) await storeNovel(db, index, IN_WINDOW);
    persistRunReceipt(
      db,
      path,
      receipt("2026-08-27", {
        run_id: "01JBUNAVAIL000000000000001",
        status: "degraded",
        claims_extracted: 8,
        claims_written: 8,
        model: { ...emptyRunTotals().model, model_ref: MODEL, unavailable: 1 },
      }),
    );
    const report = inspectServeDoctor(db, path, { now: NOW, model_ref: MODEL });
    expect(report.calibration.write_rate).toBeCloseTo(1);
    expect(report.calibration.failures).toEqual([]);
    expect(report.failures).not.toContain("confidence_not_produced");
    expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(false);
    expect(report.model.current_failure?.detail).toBe("model unavailable");
    expect(report.failures.some((item) => item.includes("model unavailable"))).toBe(true);
    expect(report.ok).toBe(false);
    db.close();
  });

  test("first-fill still fails the lower bound when extracted claims are dropped", async () => {
    const { path, db } = vault();
    await storeNovel(db, 0, IN_WINDOW);
    persistRunReceipt(
      db,
      path,
      receipt("2026-08-27", {
        run_id: "01JBFRESHLOW00000000000001",
        claims_extracted: 10,
        claims_written: 1,
      }),
    );
    const report = inspectServeDoctor(db, path, { now: NOW });
    expect(report.calibration.write_rate).toBeCloseTo(0.1);
    expect(report.ok).toBe(false);
    expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(true);
    db.close();
  });

  test("a second receipt against an in-window corpus still fails the write-rate ceiling", async () => {
    const { path, db } = vault();
    for (let index = 0; index < 8; index += 1) await storeNovel(db, index, IN_WINDOW);
    persistRunReceipt(
      db,
      path,
      receipt("2026-08-27", {
        run_id: "01JBSECONDA000000000000001",
        claims_extracted: 8,
        claims_written: 8,
      }),
    );
    persistRunReceipt(
      db,
      path,
      receipt("2026-08-28", {
        run_id: "01JBSECONDB000000000000001",
        claims_extracted: 10,
        claims_written: 10,
        claims_deduped: 0,
      }),
    );
    const report = inspectServeDoctor(db, path, { now: NOW });
    expect(report.calibration.write_rate).toBeCloseTo(1);
    expect(report.ok).toBe(false);
    expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(true);
    expect(report.calibration.failures[0]).toContain(`${CALIBRATION_BAND.min}`);
    expect(report.calibration.failures[0]).toContain(`${CALIBRATION_BAND.max}`);
    db.close();
  });

  test("claims asserted earlier in the same second are not an initial capture", async () => {
    const { path, db } = vault();
    try {
      await storeNovel(db, 0, "2026-08-27T00:00:00.100Z");
      await storeNovel(db, 1, "2026-08-27T00:00:00.950Z");
      persistRunReceipt(db, path, {
        ...receipt("2026-08-27", {
          run_id: "01JBSUBSECONDCAPTURE000001",
          claims_extracted: 8,
          claims_written: 8,
        }),
        started_at: "2026-08-27T00:00:00.900Z",
      });
      expect(inspectServeDoctor(db, path, { now: NOW }).calibration.failures.some(
        (failure) => failure.startsWith("write_rate "),
      )).toBe(true);
    } finally {
      db.close();
    }
  });

  test("malformed historical asserted_at still fails the write-rate ceiling", async () => {
    const { path, db } = vault();
    await storeNovel(db, 0, PRIOR);
    db.query(
      `UPDATE claims
          SET asserted_at = 'malformed', status = 'superseded'
        WHERE subject = 'person:novel-0'`,
    ).run();
    await storeNovel(db, 1, IN_WINDOW);
    persistRunReceipt(
      db,
      path,
      receipt("2026-08-27", {
        run_id: "01JBMALFORMEDAT00000000001",
        claims_extracted: 8,
        claims_written: 8,
      }),
    );
    expect(
      inspectServeDoctor(db, path, { now: NOW }).failures.some((item) =>
        item.includes("write_rate"),
      ),
    ).toBe(true);
    db.close();
  });

  test("later idle receipts do not disable a true initial capture", async () => {
    const { path, db } = vault();
    for (let index = 0; index < 8; index += 1) await storeNovel(db, index, IN_WINDOW);
    persistRunReceipt(
      db,
      path,
      receipt("2026-08-27", {
        run_id: "01JBIDLEA00000000000000001",
        claims_extracted: 8,
        claims_written: 8,
      }),
    );
    persistRunReceipt(db, path, {
      ...receipt("2026-08-28", { run_id: "01JBIDLEB00000000000000001" }),
      rail: "doctor-sweep",
    });
    const report = inspectServeDoctor(db, path, { now: NOW });
    expect(report.calibration.write_rate).toBeCloseTo(1);
    expect(report.calibration.failures).toEqual([]);
    expect(report.failures.some((item) => item.startsWith("write_rate "))).toBe(false);
    expect(report.ok).toBe(true);
    db.close();
  });
});
