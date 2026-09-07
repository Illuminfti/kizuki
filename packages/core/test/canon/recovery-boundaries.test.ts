import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER, OWNER_AGENT_GRANT } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { registerConnection } from "../../src/ledger/connections";
import { accept } from "../../src/ledger/ledger";
import { inspectSourceGrant, resumeSourceRevocation, revokeSourceGrant, setSourceGrant } from "../../src/ledger/source-grants";
import { exportVault, restoreVault } from "../../src/export";
import { loadCanon, pageDecision, canonChunk } from "../../src/serving/canon";
import { gateAsync } from "../../src/serving/gate";
import { readDerivedHolds } from "../../src/derived-holds";
import { assessLivePageEvidence } from "../../src/vault/provenance";
import { recoverCanonWrites } from "../../src/canon/recovery";
import { advanceCanonReadGeneration, inspectCanonRecovery, readCanonWriteIntent } from "../../src/canon/write-intent";
import { readReceiptsLog } from "../../src/canon/receipts";
import { tempVault } from "../helpers/vault";
import { validEvent } from "../fixtures";
import { putEvent, storeClaim, write } from "./helpers";
import { ulid } from "../../src/util/ulid";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture(bound = false) {
  const vault = tempVault("canon-boundaries-"); cleanups.push(vault.dispose);
  const path = join(vault.path, ".kizuki", "kizuki.db"), db = openLedger(path);
  cleanups.push(() => db.close());
  const source = ulid();
  let eventId: string;
  if (bound) {
    registerConnection(db, "fixture", source);
    setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "grant-boundary", policy: {
      purposes: ["capture", "recall", "session", "derive", "extract", "export"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked",
      egress: "local_only", sensitivity_floor: "private",
    } });
    const result = accept(db, { ...validEvent(), connector_id: "fixture" }, { source: { source_key: source, expected_revision: 1 } });
    if (result.status !== "stored") throw new Error("fixture capture failed");
    eventId = result.event.event_id;
  } else eventId = putEvent(db);
  const io = { db, vault_path: vault.path }, claim = await storeClaim(db, eventId);
  return { db, path, vault: vault.path, source, eventId, claim, io, owner: { db, vaultPath: vault.path, principal: OWNER } };
}

function breakRows(db: ReturnType<typeof openLedger>): void {
  db.exec("CREATE TRIGGER boundary_receipt_failure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'boundary row failure'); END");
}
function allowRows(db: ReturnType<typeof openLedger>): void { db.exec("DROP TRIGGER boundary_receipt_failure"); }

test("a cached canon snapshot remains refused after another write is admitted and fully recovered", async () => {
  const f = await fixture();
  const first = write(f.io, f.claim), index = loadCanon(f.owner), page = index.byPath.get(first.page_path)!;
  expect(pageDecision(index, OWNER_AGENT_GRANT, page).allow).toBe(true);
  const second = await storeClaim(f.db, putEvent(f.db), { target: "people/jules", subject: "person:jules", subjects: ["person:jules"] });
  breakRows(f.db); expect(() => write(f.io, second)).toThrow("boundary row failure");
  const intent = readCanonWriteIntent(f.db)!;
  expect(readDerivedHolds(f.db).paths.has(intent.receipt.page_path)).toBe(true);
  const pending = loadCanon(f.owner).byPath.get(intent.receipt.page_path)!;
  expect(assessLivePageEvidence(f.db, pending)).toEqual({ admitted: false, reason: "recovery_pending" });
  expect(pageDecision(index, OWNER_AGENT_GRANT, page)).toEqual({ allow: false, reason: "held" });
  allowRows(f.db); recoverCanonWrites(f.io);
  expect(inspectCanonRecovery(f.db).pending).toBe(false);
  expect(pageDecision(index, OWNER_AGENT_GRANT, page)).toEqual({ allow: false, reason: "held" });
  expect(() => canonChunk(index, page, { sensitivity: "personal", taint: "clean" }, page.body, false)).toThrow("canon changed");
  expect(pageDecision(loadCanon(f.owner), OWNER_AGENT_GRANT, page).allow).toBe(true);
});

test("an async read rejects a completed write from a second SQLite connection even when no intent remains", async () => {
  const f = await fixture(), observer = openLedger(f.path); cleanups.push(() => observer.close());
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const result = gateAsync(f.owner, "search", {}, async () => {
    await held;
    return { canon: [], quoted: [], withheld: [] };
  });
  write({ db: observer, vault_path: f.vault }, f.claim);
  expect(inspectCanonRecovery(f.db).pending).toBe(false);
  release();
  await expect(result).rejects.toThrow("canon changed during request");
});

test("pending replay payload refuses export before callbacks or destination creation", async () => {
  const f = await fixture(); breakRows(f.db);
  expect(() => write(f.io, f.claim)).toThrow();
  let callbacks = 0;
  const out = `${f.vault}-backup`; cleanups.push(() => { if (existsSync(out)) throw new Error("unexpected backup escaped refusal"); });
  expect(() => exportVault(f.db, f.vault, out, { onProgress: () => { callbacks++; } })).toThrow("canon_recovery_pending");
  expect(callbacks).toBe(0); expect(existsSync(out)).toBe(false);
});

test("an export callback cannot hide an admission-and-completion generation change", async () => {
  const f = await fixture(), out = `${f.vault}-backup`;
  expect(() => exportVault(f.db, f.vault, out, { onProgress: phase => {
    if (phase === "staging") f.db.transaction(() => { advanceCanonReadGeneration(f.db); advanceCanonReadGeneration(f.db); }).immediate();
  } })).toThrow("canon changed during export");
  expect(existsSync(out)).toBe(false);
});

test("source withdrawal erases its published uncommitted page and exact tail without minting a positive receipt", async () => {
  const f = await fixture(true); breakRows(f.db);
  expect(() => write(f.io, f.claim)).toThrow();
  const pending = readCanonWriteIntent(f.db)!; allowRows(f.db);
  expect(readReceiptsLog(f.vault)).toHaveLength(1);
  revokeSourceGrant(f.db, { source_key: f.source, expected_revision: 1, operation_id: "withdraw-boundary" });
  expect(inspectSourceGrant(f.db, f.source)!.purge_blockers).toContain("canon_recovery_pending");
  const result = await resumeSourceRevocation(f.db, f.vault, "withdraw-boundary");
  expect(result.status).toBe("purged");
  expect(readCanonWriteIntent(f.db)).toBeNull();
  expect(existsSync(join(f.vault, pending.receipt.page_path))).toBe(false);
  expect(readReceiptsLog(f.vault).some(receipt => receipt.receipt_id === pending.receipt.receipt_id)).toBe(false);
  expect(f.db.query("SELECT 1 FROM canon_receipts WHERE receipt_id=?").get(pending.receipt.receipt_id)).toBeNull();
  expect((await resumeSourceRevocation(f.db, f.vault, "withdraw-boundary")).status).toBe("purged");
});

for (const changed of ["page", "stage"] as const) test(`withdrawal preserves changed ${changed} and reports the pending intent`, async () => {
  const f = await fixture(true); breakRows(f.db);
  expect(() => write(f.io, f.claim)).toThrow(); const pending = readCanonWriteIntent(f.db)!; allowRows(f.db);
  const path = join(f.vault, changed === "page" ? pending.receipt.page_path : pending.stages.live_stage);
  writeFileSync(path, "independent owner content", { mode: 0o600 });
  revokeSourceGrant(f.db, { source_key: f.source, expected_revision: 1, operation_id: "withdraw-boundary" });
  const grant = await resumeSourceRevocation(f.db, f.vault, "withdraw-boundary");
  expect(grant.status).toBe("denied"); expect(grant.purge_blockers).toContain("canon_recovery_pending");
  expect(readFileSync(path, "utf8")).toBe("independent owner content");
  expect(readCanonWriteIntent(f.db)?.receipt.receipt_id).toBe(pending.receipt.receipt_id);
});
