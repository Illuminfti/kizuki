import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SINGLE_SOURCE_CAP,
  accept,
  emptyRunTotals,
  insertClaim,
  persistRunReceipt,
} from "@kizuki/core";
import type { CaptureEventInput, InsertClaimInput } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "../helpers";
import { refreshDerived } from "../../src/derived";

const { cleanup, runCli, tempVault } = createHelpers();
const MODEL = "kizuki.llm.openai-compatible:synthetic@local";

afterEach(cleanup);

function doctorData(stdout: string) {
  return (
    JSON.parse(stdout) as {
      data: {
        ok: boolean;
        serve: {
          ok: boolean;
          failures: string[];
          calibration: {
            write_rate: number | null;
            confidence_spread: number | null;
            failures: string[];
          };
          model: {
            current_failure: { detail: string } | null;
            unavailable: number;
          };
        };
      };
    }
  ).data;
}

function eventInput(sourceRecordId: string, connectorId: string, text: string): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: connectorId,
    source_record_id: sourceRecordId,
    kind: "message",
    occurred_at: "2026-02-28T10:30:00Z",
    observed_at: "2026-03-01T00:00:00Z",
    text,
    subjects: [{ subject_id: "person:synthetic", role: "from", display_name: "synthetic" }],
    sensitivity_hint: "personal",
    deleted: false,
    attachments: [],
    metadata: {},
  };
}

function putEvent(
  db: ReturnType<typeof openLedger>,
  sourceRecordId: string,
  text: string,
  connectorId = "fixture",
): string {
  const accepted = accept(db, eventInput(sourceRecordId, connectorId, text));
  if (accepted.status !== "stored") {
    throw new Error(`failed to store event: ${JSON.stringify(accepted)}`);
  }
  return accepted.event.event_id;
}

async function storeClaim(
  db: ReturnType<typeof openLedger>,
  eventIds: string[],
  index: number,
  at: string,
  confidence: number,
): Promise<void> {
  const text = `synthetic person ${index} works at org-${index}.`;
  const input: InsertClaimInput = {
    kind: "claim",
    subject: `person:synthetic-${index}`,
    predicate: "employment.works_at",
    object: `org-${index}`,
    polarity: "positive",
    body: text,
    provenance: eventIds,
    subjects: [`person:synthetic-${index}`],
    producer: "deterministic",
    confidence,
    sensitivity: "personal",
    taint: "clean",
  };
  const result = await insertClaim({ db, now: () => at }, input);
  if (result.outcome !== "stored") throw new Error(`claim ${index} was ${result.outcome}`);
  if (eventIds.length === 1) {
    if (result.claim.confidence !== SINGLE_SOURCE_CAP) {
      throw new Error(`expected policy cap, got ${result.claim.confidence}`);
    }
    if (result.claim.authority !== "model_inference") {
      throw new Error(`expected model_inference, got ${result.claim.authority}`);
    }
  } else if (result.claim.confidence !== confidence) {
    throw new Error(`expected confidence ${confidence}, got ${result.claim.confidence}`);
  }
}

function persistSync(
  db: ReturnType<typeof openLedger>,
  vault: string,
  runId: string,
  at: string,
  overrides: Partial<ReturnType<typeof emptyRunTotals>> & { status?: "ok" | "degraded" } = {},
): void {
  persistRunReceipt(db, vault, {
    ...emptyRunTotals(),
    ...overrides,
    rail: "sync",
    run_id: runId,
    started_at: at,
    finished_at: at,
    status: overrides.status ?? "ok",
    stopped: null,
  });
}

function refreshLedgerIndex(db: ReturnType<typeof openLedger>, vault: string): void {
  refreshDerived(db, vault);
}

describe("doctor calibration", () => {
  test("a fresh vault of novel claims is not a broken model", async () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const at = new Date().toISOString();
    try {
      for (let index = 0; index < 8; index += 1) {
        const text = `synthetic person ${index} works at org-${index}.`;
        const eventId = putEvent(db, `novel-${index}`, text);
        await storeClaim(db, [eventId], index, at, 0.9);
      }
      persistSync(db, setup.vault, "fresh-novel", at, {
        claims_extracted: 8,
        claims_written: 8,
      });
      refreshLedgerIndex(db, setup.vault);
    } finally {
      db.close();
    }
    const result = runCli(setup.env, "doctor", "--json");
    expect(result.exitCode).toBe(0);
    const report = doctorData(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.serve.ok).toBe(true);
    expect(report.serve.calibration.write_rate).toBeCloseTo(1);
    expect(report.serve.calibration.failures).toEqual([]);
    expect(report.serve.failures.some((item) => item.startsWith("write_rate "))).toBe(false);
    expect(report.serve.failures).not.toContain("confidence_not_produced");
  });

  test("policy-capped single-source confidence is not a doctor failure", async () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const at = new Date().toISOString();
    try {
      for (let index = 0; index < 8; index += 1) {
        const text = `synthetic person ${index} works at org-${index}.`;
        const eventId = putEvent(db, `policy-${index}`, text);
        await storeClaim(db, [eventId], index, at, 0.9);
      }
      persistSync(db, setup.vault, "policy-capped", at, {
        claims_extracted: 10,
        claims_written: 4,
        claims_deduped: 3,
      });
      refreshLedgerIndex(db, setup.vault);
    } finally {
      db.close();
    }
    const result = runCli(setup.env, "doctor", "--json");
    expect(result.exitCode).toBe(0);
    const report = doctorData(result.stdout);
    expect(report.serve.calibration.write_rate).toBeCloseTo(0.4);
    expect(report.serve.calibration.failures).toEqual([]);
    expect(report.serve.failures).not.toContain("confidence_not_produced");
    expect(report.ok).toBe(true);
  });

  test("a mature vault still fails bad calibration", async () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const current = new Date().toISOString();
    const prior = new Date(Date.now() - 8 * 86_400_000).toISOString();
    try {
      for (let index = 0; index < 8; index += 1) {
        const text = `synthetic mature person ${index} works at org-${index}.`;
        const first = putEvent(db, `mature-a-${index}`, text, "fixture-a");
        const second = putEvent(db, `mature-b-${index}`, text, "fixture-b");
        await storeClaim(db, [first, second], index, prior, 0.9);
      }
      persistSync(db, setup.vault, "mature-bad", current, {
        claims_extracted: 10,
        claims_written: 10,
      });
    } finally {
      db.close();
    }
    const result = runCli(setup.env, "doctor", "--json");
    expect(result.exitCode).toBe(1);
    const report = doctorData(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.serve.ok).toBe(false);
    expect(report.serve.calibration.write_rate).toBeCloseTo(1);
    expect(report.serve.failures.some((item) => item.startsWith("write_rate "))).toBe(true);
    expect(report.serve.failures).toContain("confidence_not_produced");
  });

  test("a second receipt against an in-window corpus still fails the write-rate ceiling", async () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const later = new Date().toISOString();
    const earlier = new Date(Date.now() - 86_400_000).toISOString();
    try {
      for (let index = 0; index < 8; index += 1) {
        const text = `synthetic person ${index} works at org-${index}.`;
        const eventId = putEvent(db, `second-${index}`, text);
        await storeClaim(db, [eventId], index, earlier, 0.9);
      }
      persistSync(db, setup.vault, "second-a", earlier, {
        claims_extracted: 8,
        claims_written: 8,
      });
      persistSync(db, setup.vault, "second-b", later, {
        claims_extracted: 10,
        claims_written: 10,
        claims_deduped: 0,
      });
      refreshLedgerIndex(db, setup.vault);
    } finally {
      db.close();
    }
    const result = runCli(setup.env, "doctor", "--json");
    expect(result.exitCode).toBe(1);
    const report = doctorData(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.serve.ok).toBe(false);
    expect(report.serve.calibration.write_rate).toBeCloseTo(1);
    expect(report.serve.failures.some((item) => item.startsWith("write_rate "))).toBe(true);
    expect(report.serve.failures).not.toContain("confidence_not_produced");
  });

  test("model unavailability is reported without a calibration failure", async () => {
    const setup = tempVault();
    writeFileSync(
      join(setup.vault, ".kizuki", "serve.toml"),
      '[ports.llm]\nid = "kizuki.llm.openai-compatible"\nmodel = "synthetic@local"\n',
    );
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const at = new Date().toISOString();
    try {
      for (let index = 0; index < 8; index += 1) {
        const text = `synthetic person ${index} works at org-${index}.`;
        const eventId = putEvent(db, `unavailable-${index}`, text);
        await storeClaim(db, [eventId], index, at, 0.9);
      }
      persistSync(db, setup.vault, "model-unavailable", at, {
        status: "degraded",
        claims_extracted: 8,
        claims_written: 8,
        model: { ...emptyRunTotals().model, model_ref: MODEL, unavailable: 1 },
      });
    } finally {
      db.close();
    }
    const result = runCli(setup.env, "doctor", "--json");
    expect(result.exitCode).toBe(1);
    const report = doctorData(result.stdout);
    expect(report.serve.calibration.failures).toEqual([]);
    expect(report.serve.failures.some((item) => item.startsWith("write_rate "))).toBe(false);
    expect(report.serve.failures).not.toContain("confidence_not_produced");
    expect(report.serve.failures.some((item) => item.includes("model unavailable"))).toBe(true);
    expect(report.ok).toBe(false);
  });
});
