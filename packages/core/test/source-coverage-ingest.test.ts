import { expect, test } from "bun:test";
import type { SyncBatch } from "../src/contracts/connector";
import { KizukiError } from "../src/contracts/errors";
import { openLedger } from "../src/ledger/db";
import { getCheckpoint, registerConnection } from "../src/ledger/connections";
import { setSourceGrant } from "../src/ledger/source-grants";
import { runBackfill, runSync } from "../src/ingest/run";
import { connector } from "./connections-helpers";

const source = "01JJ0000000000000000000004";

function fixture() {
  const db = openLedger(":memory:");
  registerConnection(db, "fixture", source);
  setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "coverage-consent", policy: {
    purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "metadata", "attachments"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public",
  } });
  const base = connector(async () => ({ display: "fixture" }));
  const capture = { ...base,
    manifest: () => ({ ...base.manifest(), capabilities: { ...base.manifest().capabilities, backfill: true, sync: true } }),
    backfill: async (): Promise<SyncBatch> => ({ events: [], cursor: "done", has_more: false }),
    sync: async (): Promise<SyncBatch> => ({ events: [], cursor: "incremental", has_more: false }),
  };
  return { db, capture };
}

test("incremental sync cannot complete backfill; completion and successful-pass time survive later failures", async () => {
  const { db, capture } = fixture();
  try {
    await runSync(db, capture, "fixture", source);
    expect(getCheckpoint(db, "fixture", source)?.backfill_complete).toBe(false);
    await runBackfill(db, capture, "fixture", source);
    const successful = getCheckpoint(db, "fixture", source)?.last_result.coverage?.last_successful_pass_at;
    expect(successful).toEqual(expect.any(String));
    capture.sync = async () => { throw new KizukiError("unreachable", "synthetic source unavailable"); };
    await runSync(db, capture, "fixture", source);
    expect(getCheckpoint(db, "fixture", source)).toMatchObject({ backfill_complete: true, sync_cursor: "incremental",
      last_result: { coverage: { last_successful_pass_at: successful, last_error_class: "unreachable" } } });
  } finally { db.close(); }
});

test("coverage and checkpoint roll back together when the run receipt cannot be stored", async () => {
  const { db, capture } = fixture();
  try {
    await runSync(db, capture, "fixture", source);
    const before = getCheckpoint(db, "fixture", source);
    db.exec("CREATE TEMP TRIGGER reject_run BEFORE INSERT ON connection_runs BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
    await expect(runBackfill(db, capture, "fixture", source)).rejects.toThrow("synthetic receipt failure");
    expect(getCheckpoint(db, "fixture", source)).toEqual(before);
  } finally { db.close(); }
});

test("hostile coverage accessors are refused without executing or advancing the checkpoint", async () => {
  const { db, capture } = fixture();
  try {
    let calls = 0;
    const batch = Object.defineProperty({ events: [], cursor: "unsafe", has_more: false }, "coverage", {
      enumerable: true, get() { calls++; throw new Error("synthetic private content"); },
    });
    capture.backfill = async () => batch;
    const result = await runBackfill(db, capture, "fixture", source);
    expect(calls).toBe(0);
    expect(result.errors).toEqual(["sync batch coverage must be an own data property"]);
    expect(getCheckpoint(db, "fixture", source)).toMatchObject({ cursor: null, backfill_complete: false,
      last_result: { coverage: { last_successful_pass_at: null, last_error_class: "refused" } } });
    expect(JSON.stringify(result)).not.toContain("synthetic private content");
  } finally { db.close(); }
});
