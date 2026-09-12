import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { persistRunReceipt } from "../../src/serve/receipts";
import { writeServeIntent } from "../../src/serve/intent";
import { emptyRunTotals, RETRIEVAL_SLA_SECONDS, type SupervisorStatus } from "../../src/serve/types";
import type { SupervisorHost } from "../../src/serve/supervisor";

const dirs: string[] = [];

function vault() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-serve-doctor-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  return { path, db };
}

function host(status: SupervisorStatus): SupervisorHost {
  return {
    kind: status.kind,
    home: "/tmp",
    execStart: "kizuki serve",
    query: () => status,
    reload: () => ({ ok: true, detail: "ok" }),
    enable: () => ({ ok: true, detail: "ok" }),
    disable: () => ({ ok: true, detail: "ok" }),
  };
}

function receipt(day: string, overrides: Partial<ReturnType<typeof emptyRunTotals>> & { rail?: string; run_id: string }) {
  return {
    ...emptyRunTotals(),
    rail: overrides.rail ?? "sync",
    started_at: `${day}T00:00:00Z`,
    finished_at: `${day}T00:00:01Z`,
    status: "ok" as const,
    stopped: null,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("doctor names legacy identity authority as unavailable", () => {
  const { path, db } = vault();
  expect(inspectServeDoctor(db, path).stores.degraded).toContain(
    "identity-authority-unavailable",
  );
  db.close();
});

describe("serve doctor", () => {
  test("malformed service intent is unknown and cannot hide an active service", () => {
    const { path, db } = vault();
    try {
      writeFileSync(join(path, ".kizuki", "serve-intent"), "invalid-private-value\n", {mode: 0o600});
      const report = inspectServeDoctor(db, path, {supervisor: host({kind: "systemd", state: "active", enabled: true, unit: "synthetic", detail: "active"})});
      expect(report.ok).toBe(false);
      expect(report.intent).toBe("unknown");
      expect(report.failures).toContain("service intent unavailable or invalid");
      expect(JSON.stringify(report)).not.toContain("invalid-private-value");
    } finally { db.close(); }
  });
  test("an expected installed supervisor cannot be unknown, stopped, or unenabled", () => {
    const { path, db } = vault();
    try {
      writeServeIntent(path, "installed");
      for (const state of ["unknown", "disabled", "none", "active"] as const) {
        const report = inspectServeDoctor(db, path, { supervisor: host({ kind: "systemd", state, unit: "synthetic", enabled: false, detail: state }) });
        expect(report.ok).toBe(false);
      }
    } finally { db.close(); }
  });
  test("a masked or absent unit for an enabled vault is a failure", () => {
    const { path, db } = vault();
    writeServeIntent(path, "installed");
    const masked = inspectServeDoctor(db, path, {
      supervisor: host({
        kind: "systemd",
        state: "masked",
        unit: "kizuki@x.service",
        enabled: false,
        detail: "masked",
      }),
    });
    expect(masked.ok).toBe(false);
    expect(masked.failures.some((item) => item.includes("masked"))).toBe(true);

    const absent = inspectServeDoctor(db, path, {
      supervisor: host({
        kind: "systemd",
        state: "absent",
        unit: "kizuki@x.service",
        enabled: false,
        detail: "absent",
      }),
    });
    expect(absent.ok).toBe(false);
    expect(absent.failures.some((item) => item.includes("absent"))).toBe(true);
    db.close();
  });

  test("a deliberately disabled service is reported without failing", () => {
    const { path, db } = vault();
    writeServeIntent(path, "opted-out");
    const report = inspectServeDoctor(db, path, {
      supervisor: host({
        kind: "systemd",
        state: "disabled",
        unit: "kizuki@x.service",
        enabled: false,
        detail: "disabled by owner",
      }),
    });
    expect(report.supervisor.detail).toBe("disabled by owner");
    expect(report.failures.some((item) => item.includes("supervisor"))).toBe(false);
    expect(report.ok).toBe(true);
    db.close();
  });

  test("a rail with five empty runs in a row is reported down", () => {
    const { path, db } = vault();
    writeServeIntent(path, "installed");
    for (let index = 1; index <= 5; index += 1) {
      persistRunReceipt(
        db,
        path,
        receipt(`2026-09-0${index}`, {
          run_id: `01JBEMPTY0000000000000000${index}`,
          rail: "sync",
        }),
      );
    }
    const report = inspectServeDoctor(db, path, {
      now: "2026-09-03T00:10:00Z",
      supervisor: host({
        kind: "systemd",
        state: "active",
        unit: "kizuki@x.service",
        enabled: true,
        detail: "active",
      }),
    });
    const sync = report.rails.find((rail) => rail.rail === "sync");
    expect(sync?.status).toBe("down");
    expect(sync?.reason).toContain("empty streak");
    expect(report.ok).toBe(false);
    db.close();
  });

  test("doctor reports canon writing off with no model configured", () => {
    const { path, db } = vault();
    writeServeIntent(path, "opted-out");
    const report = inspectServeDoctor(db, path);
    expect(report.model.canon_writing).toBe("off");
    expect(report.model.detail).toContain("no model configured");
    expect(report.model.detail).toContain("connectors, ledger, search, timeline and undo still work");
    expect(report.stores.derived.search.rebuilt_at).toBeNull();
    expect(report.stores.derived.graph.doc_count).toBe(0);
    expect(report.stores.writers).toEqual({
      loop: 0,
      correction: 0,
      import: 0,
      revert: 0,
    });
    expect(report.stores.origin).toEqual({ machine: 0, human: 0 });
    expect(report.calibration.failures).toEqual([]);
    db.close();
  });

  test("seven days of receipts feed calibration", () => {
    const { path, db } = vault();
    writeServeIntent(path, "opted-out");
    for (let day = 1; day <= 7; day += 1) {
      persistRunReceipt(
        db,
        path,
        receipt(`2026-08-2${day}`, {
          run_id: `01JBCALIB0000000000000000${day}`,
          claims_extracted: 10,
          claims_written: 4,
          claims_deduped: 3,
        }),
      );
    }
    const report = inspectServeDoctor(db, path, { now: "2026-08-28T00:00:00Z" });
    expect(report.calibration.write_rate).toBeCloseTo(0.4);
    expect(report.calibration.dedup_rate).toBeCloseTo(0.3);
    expect(report.calibration.failures).toEqual([]);
    db.close();
  });

  test("a pending retrieval op older than the SLA is a doctor failure", () => {
    const { path, db } = vault();
    writeServeIntent(path, "opted-out");
    db.query(
      `INSERT INTO retrieval_ops (op_id, store, op, doc_id, state, created_at, done_at)
       VALUES (?, ?, 'upsert', ?, 'pending', ?, NULL)`,
    ).run(
      "op-stale",
      "kizuki.retrieval.fts5",
      "page:facts/stale",
      "2026-09-02T12:00:00.000Z",
    );
    const fresh = inspectServeDoctor(db, path, { now: "2026-09-02T12:00:00.000Z" });
    expect(fresh.failures).not.toContain("retrieval_ops older than SLA");
    expect(fresh.stores.degraded).not.toContain("retrieval-ops-stale");

    const stale = inspectServeDoctor(db, path, { now: "2026-09-02T12:16:00.000Z" });
    expect(stale.ok).toBe(false);
    expect(stale.failures).toContain("retrieval_ops older than SLA");
    expect(stale.stores.degraded).toContain("retrieval-ops-stale");
    expect(stale.stores.oldest_retrieval_op_age_s).toBeGreaterThan(RETRIEVAL_SLA_SECONDS);
    db.close();
  });

  test("pending retrieval op counts are not silently capped at the list window", () => {
    const { path, db } = vault();
    writeServeIntent(path, "opted-out");
    const insert = db.query(
      `INSERT INTO retrieval_ops (op_id, store, op, doc_id, state, created_at, done_at)
       VALUES (?, 'kizuki.retrieval.fts5', 'upsert', ?, 'pending', '2026-09-02T12:00:00.000Z', NULL)`,
    );
    db.exec("BEGIN");
    for (let i = 0; i < 10_001; i += 1) {
      insert.run(`op-${i}`, `page:facts/${i}`);
    }
    db.exec("COMMIT");
    const report = inspectServeDoctor(db, path, { now: "2026-09-02T12:00:00.000Z" });
    expect(report.stores.pending_retrieval_ops).toBe(10_001);
    db.close();
  });
});
