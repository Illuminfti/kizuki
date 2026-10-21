import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(15_000);
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite, createBudgetTracker, recoverCanonWrites, resolveTarget, undoReceipt } from "../../src/canon";
import { readCanonWriteIntent } from "../../src/canon/write-intent";
import { correctionRecoveryPending } from "../../src/correction/recovery";
import { getClaim, insertClaim, listSupersessions } from "../../src/claims/store";
import { serveCorrect } from "../../src/serving/correct";
import { ServeError } from "../../src/serving/types";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

async function writtenUnkeyed(live: Fixture, target: string, body: string, eventId: string, subject = "topic:compiler"): Promise<{ claimId: string; pagePath: string }> {
  const filed = await insertClaim({ db: live.db }, {
    kind: "claim", target, body,
    frontmatter: { type: "fact", title: "Compiler cadence" },
    subjects: [subject], provenance: [eventId], producer: "deterministic", confidence: 1,
  });
  if (filed.outcome !== "stored") throw new Error(`fixture claim was ${filed.outcome}`);
  expect(filed.claim.claim_key).toBeNull();
  const io = { db: live.db, vault_path: live.vaultPath };
  const receipt = applyCanonWrite(io, filed.claim, resolveTarget(io, filed.claim), {
    writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
  });
  return { claimId: filed.claim.claim_id, pagePath: receipt.page_path };
}

test("an owner correction retires exactly one legacy claim, replays, and undoes", async () => {
  fixture = await serveFixture({ held: false });
  const live = fixture;
  const { claimId, pagePath } = await writtenUnkeyed(live, "facts:compiler", "The compiler ships nightly.", live.events.public!);
  const hidden = await writtenUnkeyed(live, "facts:compiler-private", "The compiler has a confidential release canary.", live.events.private!, "topic:secret");
  const before = readFileSync(join(live.vaultPath, pagePath), "utf8");
  const args = { statement: "The compiler ships weekly.", target: { claim_id: claimId } };

  const first = await serveCorrect(live.owner(), args);
  expect(first.data?.superseded.map((entry) => entry.claim_id)).toEqual([claimId]);
  expect(getClaim(live.db, claimId)?.status).toBe("superseded");
  expect(getClaim(live.db, hidden.claimId)?.status).toBe("live");
  expect(readFileSync(join(live.vaultPath, pagePath), "utf8")).toContain("weekly");
  expect(readFileSync(join(live.vaultPath, hidden.pagePath), "utf8")).toContain("confidential release canary");
  expect(listSupersessions(live.db).filter((row) => row.loser === claimId)).toHaveLength(1);

  const replay = await serveCorrect(live.owner(), args);
  expect(replay.data?.claim_id).toBe(first.data?.claim_id);
  expect(replay.data?.answer).toContain("already recorded");
  expect(listSupersessions(live.db).filter((row) => row.loser === claimId)).toHaveLength(1);

  await undoReceipt({ db: live.db, vault_path: live.vaultPath }, first.data!.receipt_id!);
  expect(getClaim(live.db, claimId)?.status).toBe("live");
  expect(readFileSync(join(live.vaultPath, pagePath), "utf8")).toBe(before);
});

for (const principal of ["owner", "agent"] as const) test(`an interrupted ${principal} legacy correction stays pending until recovery, then undoes`, async () => {
  fixture = await serveFixture({ held: false });
  const live = fixture;
  const { claimId, pagePath } = await writtenUnkeyed(live, "facts:compiler", "The compiler ships nightly.", live.events.public!);
  const before = readFileSync(join(live.vaultPath, pagePath), "utf8");
  const ctx = principal === "owner" ? live.owner() : live.agent("reader-public");
  const args = { statement: "The compiler ships weekly.", target: { claim_id: claimId } };
  live.db.exec("CREATE TRIGGER synthetic_legacy_receipt_failure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic-legacy-receipt-failure'); END");
  const first = await serveCorrect(ctx, args);
  expect(readCanonWriteIntent(live.db)?.receipt.claim_ids).toContain(first.data!.claim_id!);
  expect(correctionRecoveryPending(live.db, first.data!.claim_id!).length).toBeGreaterThan(0);
  expect(first.data?.recovery_pending).toBeDefined();
  if (principal === "owner") expect(first.data?.recovery_pending?.length).toBeGreaterThan(0);
  else {
    expect(first.data?.recovery_pending).toEqual([]);
    expect(JSON.stringify(first)).not.toContain(pagePath);
  }
  expect(first.data?.receipt_id).toBeNull();
  expect(first.data?.rewritten).toEqual([]);
  expect(first.data?.answer).not.toContain("kizuki undo");
  const state = () => live.db.query<{ filing_state: string }, [string]>(
    "SELECT filing_state FROM native_owner_evidence WHERE event_id=?",
  ).get(first.data!.event_id!)?.filing_state;
  expect(state()).toBe("recorded");
  expect(readFileSync(join(live.vaultPath, pagePath), "utf8")).toContain("weekly");
  const retry = await serveCorrect(ctx, args);
  expect(retry.data?.claim_id).toBe(first.data?.claim_id);
  expect(retry.data?.recovery_pending).toEqual(first.data?.recovery_pending);
  expect(state()).toBe("recorded");
  expect(retry.data?.receipt_id).toBeNull();
  expect(retry.data?.rewritten).toEqual([]);
  expect(retry.data?.answer).toContain("recovery remains pending");
  if (principal === "agent") expect(JSON.stringify(retry)).not.toContain(pagePath);
  live.db.exec("DROP TRIGGER synthetic_legacy_receipt_failure");
  expect(recoverCanonWrites({ db: live.db, vault_path: live.vaultPath }).pending).toBe(false);
  const receiptId = getClaim(live.db, first.data!.claim_id!)?.receipt_id;
  expect(receiptId).toBeString();
  expect(readFileSync(join(live.vaultPath, pagePath), "utf8")).toContain("weekly");
  await undoReceipt({ db: live.db, vault_path: live.vaultPath }, receiptId!);
  expect(getClaim(live.db, claimId)?.status).toBe("live");
  expect(readFileSync(join(live.vaultPath, pagePath), "utf8")).toBe(before);
});

test("a scoped agent corrects its readable legacy claim without receiving hidden sibling data", async () => {
  fixture = await serveFixture({ held: false });
  const live = fixture;
  const { claimId, pagePath } = await writtenUnkeyed(live, "facts:compiler", "The compiler ships nightly.", live.events.public!);
  const hidden = await writtenUnkeyed(live, "facts:compiler-private", "The compiler has a confidential release canary.", live.events.private!, "topic:secret");

  const result = await serveCorrect(live.agent("reader-public"), {
    statement: "The compiler ships weekly.", target: { claim_id: claimId },
  });
  expect(getClaim(live.db, claimId)?.status).toBe("superseded");
  expect(getClaim(live.db, hidden.claimId)?.status).toBe("live");
  const response = JSON.stringify(result);
  expect(result.data?.rewritten.map((page) => page.page_path)).toEqual([pagePath]);
  expect(result.data?.receipt_id).not.toBeNull();
  expect(response).toContain(pagePath);
  expect(response).not.toContain(hidden.pagePath);
  expect(response).not.toContain("confidential release canary");
});

test("a scoped agent cannot use exact legacy correction to probe a hidden claim", async () => {
  fixture = await serveFixture({ held: false });
  const live = fixture;
  const hidden = await writtenUnkeyed(live, "facts:compiler-private", "The compiler has a confidential release canary.", live.events.private!);

  const error = await serveCorrect(live.agent("reader-public"), {
    statement: "The compiler ships weekly.", target: { claim_id: hidden.claimId },
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ServeError);
  expect((error as ServeError).message).toBe("invalid arguments: target.claim_id: names no live claim");
  expect(JSON.stringify(error)).not.toContain("confidential release canary");
  expect(getClaim(live.db, hidden.claimId)?.status).toBe("live");
});

test("a legacy correction rejects an asserted replacement", async () => {
  fixture = await serveFixture({ held: false });
  const live = fixture;
  const { claimId } = await writtenUnkeyed(live, "facts:compiler", "The compiler ships nightly.", live.events.public!);
  const error = await serveCorrect(live.owner(), {
    statement: "The compiler ships weekly.", object: "weekly", target: { claim_id: claimId },
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ServeError);
  expect((error as ServeError).message).toContain("retracted and not replaced");
  expect(getClaim(live.db, claimId)?.status).toBe("live");
});
