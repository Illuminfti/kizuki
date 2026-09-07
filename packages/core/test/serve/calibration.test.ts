import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../../src/vault/init";
import { openLedger } from "../../src/ledger/db";
import { insertClaim } from "../../src/claims/store";
import { claimInput, putEvent } from "../claims/helpers";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { persistRunReceipt } from "../../src/serve/receipts";
import { emptyRunTotals } from "../../src/serve/types";
import { writeServeIntent } from "../../src/serve/intent";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { registerConnection } from "../../src/ledger/connections";

const NOW = "2026-09-02T12:10:00.000Z";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-calibration-")); dirs.push(dir);
  const path = join(dir, "vault"); initVault(path); writeServeIntent(path, "opted-out");
  return { path, db: openLedger(join(path, ".kizuki", "kizuki.db")) };
}
async function population(db: ReturnType<typeof fixture>["db"], options: { count?: number; repeat?: "same" | "independent"; flat?: number; baseConfidence?: number } = {}) {
  const claims = [];
  for (let n = 0; n < (options.count ?? 8); n++) {
    for (let observation = 0; observation < (options.repeat ? 2 : 1); observation++) {
      const event = putEvent(db, { connector_id: observation && options.repeat === "independent" ? "independent-fixture" : "fixture", source_record_id: `record-${n}-${observation}`, text: `Person ${n} works at Company ${n}, observation ${observation}.` });
      const result = await insertClaim({ db, now: () => "2026-09-02T12:00:00.000Z" }, claimInput(event, {
        producer: "model", subject: `person:fixture-${n}`, subjects: [`person:fixture-${n}`], object: `company-${n}`,
        body: `Person ${n} works at Company ${n}, observation ${observation}.`, confidence: options.flat ?? (options.baseConfidence ?? 0.71) + n * 0.03,
      }));
      if (result.outcome !== "stored" && result.outcome !== "duplicate") throw new Error(`fixture admission failed: ${result.outcome}`);
      if (observation === (options.repeat ? 1 : 0)) claims.push(result.claim);
    }
  }
  return claims;
}
function receipt(db: ReturnType<typeof fixture>["db"], path: string, extracted: number, written: number, deduped: number) {
  persistRunReceipt(db, path, { ...emptyRunTotals(), run_id: "01JCALIBRATION00000000001", rail: "sync", started_at: "2026-09-02T12:00:00.000Z", finished_at: "2026-09-02T12:00:01.000Z", status: "ok", stopped: null, claims_extracted: extracted, claims_written: written, claims_deduped: deduped });
}
function inspect(db: ReturnType<typeof fixture>["db"], path: string) { return inspectServeDoctor(db, path, { now: NOW }); }

test("fresh distinct capped claims report healthy but explicitly unevaluable calibration", async () => {
  const { path, db } = fixture();
  try {
    await population(db); receipt(db, path, 8, 8, 0);
    const report = inspect(db, path);
    expect(report.ok).toBe(true);
    expect(report.calibration.failures).toEqual([]);
    expect(report.calibration.write_rate_evaluation).toBe("lower-bound-only");
    expect(report.calibration.confidence_evaluation).toBe("insufficient-uncapped-model-claims");
    expect(report.calibration.confidence_unevaluable).toBe(8);
  } finally { db.close(); }
});

test("same-connector corroboration does not turn capped scores into model calibration evidence", async () => {
  const { path, db } = fixture();
  try {
    const claims = await population(db, { repeat: "same" }); receipt(db, path, 16, 8, 8);
    expect(claims.every(claim => claim.corroboration === 2 && claim.confidence === 0.5)).toBe(true);
    const report = inspect(db, path);
    expect(report.calibration.failures).toEqual([]);
    expect(report.calibration.confidence_samples).toBe(0);
    expect(report.calibration.confidence_evaluation).toBe("insufficient-uncapped-model-claims");
    expect(report.calibration.write_rate_evaluation).toBe("evaluated");
  } finally { db.close(); }
});

test("a mature varied uncapped model population remains healthy and evaluable", async () => {
  const { path, db } = fixture();
  try {
    await population(db, { repeat: "independent" }); receipt(db, path, 16, 8, 8);
    const report = inspect(db, path);
    expect(report.calibration.failures).toEqual([]);
    expect(report.calibration.confidence_samples).toBe(8);
    expect(report.calibration.confidence_evaluation).toBe("evaluated");
  } finally { db.close(); }
});

test("flat uncapped model confidence still fails mature calibration", async () => {
  const { path, db } = fixture();
  try {
    await population(db, { repeat: "independent", flat: 0.7 }); receipt(db, path, 16, 8, 8);
    const report = inspect(db, path);
    expect(report.ok).toBe(false);
    expect(report.calibration.failures).toContain("confidence_not_produced");
    expect(report.calibration.confidence_evaluation).toBe("evaluated");
  } finally { db.close(); }
});

test("a genuine model score at the policy cap is explicitly ambiguous even after independent repetition", async () => {
  const { path, db } = fixture();
  try {
    await population(db, { repeat: "independent", flat: 0.5 }); receipt(db, path, 16, 8, 8);
    const report = inspect(db, path);
    expect(report.calibration.confidence_evaluation).toBe("insufficient-uncapped-model-claims");
    expect(report.calibration.confidence_unevaluable).toBe(8);
  } finally { db.close(); }
});

test("one prior repeat cannot make a mostly fresh population fail the dedup-dependent ceiling", async () => {
  const { path, db } = fixture();
  try {
    await population(db, { repeat: "same" }); receipt(db, path, 100, 99, 1);
    expect(inspect(db, path).calibration.failures).toEqual([]);
    expect(inspect(db, path).calibration.write_rate_evaluation).toBe("lower-bound-only");
  } finally { db.close(); }
});

test("both original write-rate bounds still fail when current receipts prove sufficient dedup opportunity", async () => {
  for (const written of [1, 20]) {
    const { path, db } = fixture();
    try {
      receipt(db, path, 20, written, 5);
      expect(inspect(db, path).calibration.failures.some(f => f.startsWith("write_rate"))).toBe(true);
      expect(inspect(db, path).calibration.write_rate_evaluation).toBe("evaluated");
    } finally { db.close(); }
  }
});

test("repeated live facts expose a failed deduplicator even when its receipts count zero dedup", async () => {
  const { path, db } = fixture();
  try {
    await population(db);
    // Simulate the defect under observation: a writer persisted duplicate
    // semantic facts instead of consolidating them. Different objects never count.
    db.query("UPDATE claims SET claim_key = 'repeated-key', object = 'same-object'").run();
    receipt(db, path, 8, 8, 0);
    expect(inspect(db, path).calibration.failures).toContain("residual_duplicate_claims 7");
  } finally { db.close(); }
});

test("old duplicate facts and current distinct values cannot establish current-window dedup opportunity", async () => {
  const { path, db } = fixture();
  try {
    await population(db);
    db.query("UPDATE claims SET claim_key = 'same-predicate'").run();
    receipt(db, path, 8, 8, 0);
    expect(inspect(db, path).calibration.write_rate_evaluation).toBe("lower-bound-only");
    db.query("UPDATE claims SET object = 'same-object', asserted_at = '2026-08-01T00:00:00.000Z'").run();
    expect(inspect(db, path).calibration.write_rate_evaluation).toBe("lower-bound-only");
  } finally { db.close(); }
});


test("fresh uncapped scores remain evaluable without requiring corroboration", async () => {
  const { path, db } = fixture();
  try {
    await population(db, { baseConfidence: 0.15 }); receipt(db, path, 8, 8, 0);
    const report = inspect(db, path);
    expect(report.calibration.failures).toEqual([]);
    expect(report.calibration.confidence_evaluation).toBe("evaluated");
    expect(report.calibration.confidence_unevaluable).toBe(0);
  } finally { db.close(); }
});

test("old flat model scores cannot contaminate current-window calibration", async () => {
  const { path, db } = fixture();
  try {
    await population(db, { repeat: "independent", flat: 0.7 });
    db.query("UPDATE claims SET asserted_at = '2026-08-01T00:00:00.000Z'").run();
    receipt(db, path, 16, 8, 8);
    const report = inspect(db, path);
    expect(report.calibration.failures).toEqual([]);
    expect(report.calibration.confidence_evaluation).toBe("insufficient-uncapped-model-claims");
  } finally { db.close(); }
});


test("the lower write-rate bound remains active before dedup maturity", () => {
  const { path, db } = fixture();
  try {
    receipt(db, path, 20, 0, 0);
    const report = inspect(db, path);
    expect(report.calibration.write_rate_evaluation).toBe("lower-bound-only");
    expect(report.calibration.failures).toContain("write_rate 0.000 outside [0.15, 0.75]");
    expect(report.ok).toBe(false);
  } finally { db.close(); }
});

test("initial two-event genuine half scores retain the flat-confidence health gate", async () => {
  const { path, db } = fixture();
  try {
    for (let n = 0; n < 8; n++) {
      const one = putEvent(db, { source_record_id: `multi-${n}-1` });
      const two = putEvent(db, { source_record_id: `multi-${n}-2` });
      const result = await insertClaim({ db, now: () => "2026-09-02T12:00:00.000Z" }, claimInput(one, {
        producer: "model", subject: `multi-${n}`, subjects: [`multi-${n}`], body: `Multi fact ${n}`,
        object: `value-${n}`, confidence: 0.5, provenance: [one, two],
      }));
      expect(result.outcome).toBe("stored");
    }
    receipt(db, path, 8, 8, 0);
    expect(inspect(db, path).calibration.confidence_samples).toBe(8);
    expect(inspect(db, path).calibration.failures).toContain("confidence_not_produced");
    db.query("UPDATE claims SET provenance=json_array(json_extract(provenance,'$[0]'),json_extract(provenance,'$[0]'))").run();
    expect(inspect(db, path).calibration.confidence_unevaluable).toBe(8);
  } finally { db.close(); }
});

test("current residual duplicates compare against older eligible facts without changing the receipt ratio", async () => {
  const { path, db } = fixture();
  try {
    const old = await population(db);
    db.query("UPDATE claims SET asserted_at='2026-08-01T00:00:00.000Z'").run();
    for (let n = 0; n < old.length; n++) {
      const event = putEvent(db, { source_record_id: `current-${n}` });
      const result = await insertClaim({ db, now: () => "2026-09-02T12:00:00.000Z" }, claimInput(event, {
        producer: "model", subject: `current-${n}`, subjects: [`current-${n}`], body: `Current fact ${n}`, object: `current-${n}`,
      }));
      if (result.outcome !== "stored") throw new Error("current fixture not stored");
      db.query("UPDATE claims SET claim_key=?,object=? WHERE claim_id=?").run(old[n]!.claim_key, old[n]!.object, result.claim.claim_id);
    }
    receipt(db, path, 8, 8, 0);
    const cal = inspect(db, path).calibration;
    expect(cal.failures).toContain("residual_duplicate_claims 8");
    expect(cal.write_rate_evaluation).toBe("lower-bound-only");
    expect(cal.residual_duplicate_claims).toBe(8);
    expect(cal.duplicate_evaluation).toBe("evaluated");
    db.query("UPDATE claims SET polarity='negative' WHERE asserted_at >= '2026-09-02'").run();
    expect(inspect(db, path).calibration.residual_duplicate_claims).toBe(0);
    db.query("UPDATE claims SET polarity='positive'").run();
    const source = "01JC0000000000000000000001";
    registerConnection(db, "fixture", source);
    setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "calibration-enable-consent",
      policy: { purposes: ["capture", "recall"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" } });
    // Consent is now enforced: the historical unbound observations cannot be
    // reused by a model, so they do not prove a missed dedup opportunity.
    expect(inspect(db, path).calibration.residual_duplicate_claims).toBe(0);
    db.query("UPDATE claims SET provenance='[\"missing-event\"]' WHERE asserted_at < '2026-09-02'").run();
    expect(inspect(db, path).calibration.duplicate_evaluation).toBe("limited");
  } finally { db.close(); }
});

test("a capped aggregate cannot borrow initial multi-event provenance as uncapped evidence", async () => {
  const { path, db } = fixture();
  try {
    for (let n = 0; n < 8; n++) {
      const one = putEvent(db, { source_record_id: `aggregate-${n}-1` });
      const two = putEvent(db, { source_record_id: `aggregate-${n}-2` });
      const common = { producer: "model" as const, subject: `aggregate-${n}`, subjects: [`aggregate-${n}`], object: `value-${n}` };
      await insertClaim({ db, now: () => "2026-09-02T12:00:00.000Z" }, claimInput(one, { ...common, body: `Initial ${n}`, confidence: 0.3, provenance: [one, two] }));
      const third = putEvent(db, { source_record_id: `aggregate-${n}-3` });
      const repeated = await insertClaim({ db, now: () => "2026-09-02T12:01:00.000Z" }, claimInput(third, { ...common, body: `Repeated ${n}`, confidence: 0.9 }));
      expect(repeated.outcome).toBe("duplicate");
      if (repeated.outcome === "duplicate") expect(repeated.claim.confidence).toBe(0.5);
    }
    receipt(db, path, 16, 8, 8);
    expect(inspect(db, path).calibration.confidence_unevaluable).toBe(8);
  } finally { db.close(); }
});
