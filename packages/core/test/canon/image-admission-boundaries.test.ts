import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chargeCanonWrite, createBudgetTracker } from "../../src/canon/budget";
import { CanonWriteError } from "../../src/canon/errors";
import { snapshotCanonIo, withCanonMutationSync } from "../../src/canon/io";
import { commitCanonWrite, recoverCanonWrites, type PreparedCanonCommit } from "../../src/canon/recovery";
import { RECEIPTS_PATH } from "../../src/canon/receipts";
import { CanonRecoveryError, readCanonWriteIntent } from "../../src/canon/write-intent";
import { writeRailCursor } from "../../src/ledger/checkpoints";
import { MAX_CANON_IMAGE_BYTES } from "../../src/ledger/canon-recovery-schema";
import { sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";
import { ABSENT_PAGE_HASH, archiveRelPath, hashBytes } from "../../src/vault/write";
import { canonFixture, putEvent, storeClaim, write, type CanonFixture } from "./helpers";

const fixtures: CanonFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose(); });
function fixture() {
  const f = canonFixture(); fixtures.push(f);
  writeRailCursor(f.db, "synthetic.image-boundary", "unchanged", "cursor-before");
  return f;
}

// Multibyte text makes a character-count check observably wrong at the byte cap.
function image(bytes: number) {
  const prefix = "---\nsources: []\n---\n", bodyBytes = bytes - Buffer.byteLength(prefix);
  return Buffer.from(prefix + "é".repeat(Math.floor(bodyBytes / 2)) + "a".repeat(bodyBytes % 2));
}
function prepared(before: Buffer | null, after: Buffer | null): PreparedCanonCommit {
  const receiptId = ulid(), page = "people/image-boundary.md";
  return {
    before, after,
    receipt: { receipt_id: receiptId, kind: "write", claim_ids: [], page_path: page,
      page_action: before === null ? "create" : "edit", before_hash: before === null ? null : hashBytes(before),
      after_hash: after === null ? ABSENT_PAGE_HASH : hashBytes(after),
      archive_path: before === null ? null : archiveRelPath(page, receiptId), writer: "loop", producer: "deterministic",
      model_ref: null, authority: "connector_evidence", confidence: 0.8, sensitivity: "private", taint: "quoted",
      provenance: [], superseded: [], candidates: [], retrieval_ops: [], reverts: null, reverted_by: null,
      at: "2026-10-22T00:00:00.000Z" },
    completion: { mode: "write", claim_kind: "claim", page_id: "person:image-boundary", subject_key: null, original_receipt_id: null },
  };
}

function state(f: CanonFixture) {
  const files: Record<string, string> = {};
  const visit = (relative: string) => {
    if (!existsSync(join(f.vault, relative))) return;
    for (const entry of readdirSync(join(f.vault, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) visit(path);
      else files[path] = hashBytes(readFileSync(join(f.vault, path)));
    }
  };
  for (const directory of ["people", "archive", ".kizuki/receipts"]) visit(directory);
  // All ledger rows, including intents, receipts, reservations and rail cursors.
  return { ledger: hashBytes(f.db.serialize()), files };
}

for (const side of ["before", "after", "both"] as const) {
  test(`oversized ${side} images refuse before admission, charging, receipt storage or page changes`, () => {
    const f = fixture(), oversized = image(MAX_CANON_IMAGE_BYTES + 1);
    expect(oversized.length).toBe(MAX_CANON_IMAGE_BYTES + 1);
    expect(oversized.toString("utf8").length).toBeLessThan(MAX_CANON_IMAGE_BYTES);
    const input = prepared(side === "after" ? null : oversized, side === "before" ? image(128) : oversized);
    if (input.before !== null) {
      mkdirSync(join(f.vault, "people"), { mode: 0o700 });
      writeFileSync(join(f.vault, input.receipt.page_path), input.before, { mode: 0o600 });
    }
    const before = state(f), budget = createBudgetTracker({ canon_writes_per_run: 1 });
    let admissions = 0, charges = 0, caught: unknown;
    try {
      withCanonMutationSync(snapshotCanonIo(f.io), (scope, io) => commitCanonWrite(scope, io, input,
        () => { admissions++; },
        () => { charges++; chargeCanonWrite(io, budget, input.receipt); }));
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CanonWriteError);
    expect(caught).not.toBeInstanceOf(CanonRecoveryError);
    expect((caught as CanonWriteError).code).toBe("page_too_large");
    expect(admissions).toBe(0); expect(charges).toBe(0);
    expect(budget.usage().canon_writes_per_run.used).toBe(0);
    expect(readCanonWriteIntent(f.db)).toBeNull();
    expect(state(f)).toEqual(before);
  });
}

for (const side of ["before", "after", "both"] as const) {
  test(`exact byte-cap ${side} images reach ordinary admission without relaxing its authority check`, () => {
    const f = fixture(), exact = image(MAX_CANON_IMAGE_BYTES);
    const input = prepared(side === "after" ? null : exact, side === "before" ? null : exact);
    const denied = new Error("synthetic admission denial");
    let admissions = 0, charges = 0, caught: unknown;
    // This boundary probe deliberately stops at admission; real publication is tested through the public writer separately.
    try {
      withCanonMutationSync(snapshotCanonIo(f.io), (scope, io) => commitCanonWrite(scope, io, input,
        () => { admissions++; throw denied; }, () => { charges++; }));
    } catch (error) { caught = error; }
    expect(caught).toBe(denied); expect(admissions).toBe(1); expect(charges).toBe(0);
    expect(readCanonWriteIntent(f.db)).toBeNull();
  });
}

async function pendingFixture() {
  const f = fixture(), claim = await storeClaim(f.db, putEvent(f.db));
  f.db.exec("CREATE TRIGGER image_boundary_failure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic receipt failure'); END");
  expect(() => write(f.io, claim)).toThrow("synthetic receipt failure");
  f.db.exec("DROP TRIGGER image_boundary_failure");
  expect(readCanonWriteIntent(f.db)).not.toBeNull();
  return f;
}

test("pending recovery takes precedence over an oversized new candidate", async () => {
  const f = await pendingFixture(), before = state(f);
  let admissions = 0, caught: unknown;
  try {
    withCanonMutationSync(snapshotCanonIo(f.io), (scope, io) => commitCanonWrite(scope, io,
      prepared(null, image(MAX_CANON_IMAGE_BYTES + 1)), () => { admissions++; }));
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(CanonRecoveryError);
  expect((caught as CanonRecoveryError).reason).toBe("recovery_pending");
  expect(admissions).toBe(0); expect(state(f)).toEqual(before);
});

for (const side of ["before", "after"] as const) {
  test(`an oversized persisted ${side} image remains a recovery failure and preserves the original intent`, async () => {
    const f = await pendingFixture();
    const row = f.db.query<{ intent: string }, []>("SELECT intent FROM canon_write_intents").get()!;
    const intent = JSON.parse(row.intent);
    intent[`${side}_base64`] = image(MAX_CANON_IMAGE_BYTES + 1).toString("base64");
    const json = JSON.stringify(intent);
    // Recompute the outer digest so refusal must reach the unchanged image decoder.
    f.db.query("UPDATE canon_write_intents SET intent=?,digest=?").run(json, sha256Hex(json));
    const before = state(f), page = readFileSync(join(f.vault, intent.receipt.page_path));
    const log = readFileSync(join(f.vault, RECEIPTS_PATH));
    let caught: unknown, admissions = 0;
    try {
      withCanonMutationSync(snapshotCanonIo(f.io), (scope, io) => commitCanonWrite(scope, io,
        prepared(null, image(MAX_CANON_IMAGE_BYTES + 1)), () => { admissions++; }));
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CanonRecoveryError);
    expect((caught as CanonRecoveryError).reason).toBe("intent_invalid");
    expect(admissions).toBe(0); expect(state(f)).toEqual(before);
    expect(() => recoverCanonWrites(f.io)).toThrow(CanonRecoveryError);
    expect(readFileSync(join(f.vault, intent.receipt.page_path))).toEqual(page);
    expect(readFileSync(join(f.vault, RECEIPTS_PATH))).toEqual(log);
    expect(f.db.query("SELECT intent FROM canon_write_intents").get()).toEqual({ intent: json });
    expect(hashBytes(f.db.serialize())).toBe(before.ledger);
  });
}
