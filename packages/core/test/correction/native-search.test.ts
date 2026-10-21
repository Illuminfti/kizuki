import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER, addAgent, authenticate } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { recordNativeCorrectionEvent } from "../../src/ledger/ledger";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { rebuildRetrieval } from "../../src/retrieval/rebuild";
import { serveCorrect } from "../../src/serving/correct";
import { serveSearch } from "../../src/serving/search";
import { serveContextPacket } from "../../src/serving/packet";
import { serveWorldView } from "../../src/serving/world-view";
import { removeDoc } from "../../src/search/indexer";
import { backupVault, restoreSnapshot } from "../../src/snapshot";
import { correctionKit } from "../helpers/world-correct-kit";
import { tempVault } from "../helpers/vault";
import { validEvent } from "../fixtures";

const STATEMENT = "Waiting for independent verification.";
const SUBJECT = "project:orchard";

async function fixture() {
  const vault = tempVault("kizuki-native-search-");
  const db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  const kit = correctionKit(db, vault.path);
  await kit.declare("situation", SUBJECT, "Orchard");
  await kit.write({ subject: SUBJECT, predicate: "situation.blocker", object: { literal: "Waiting for initial review." } });
  kit.materialize(SUBJECT);
  const card = kit.card(kit.ctx, "situation", kit.find(kit.ctx, "situation", "Orchard"));
  const args = { statement: STATEMENT, object: STATEMENT, target: { world_claim: card.blocker.claim } };
  return { db, vault, kit, args };
}

test("native correction is immediately searchable after source withdrawal and survives reopen, restore and rebuild", async () => {
  const f = await fixture();
  const scratch = mkdtempSync(join(tmpdir(), "kizuki-native-search-backup-"));
  let reopened: ReturnType<typeof openLedger> | undefined;
  let restored: ReturnType<typeof openLedger> | undefined;
  try {
    const correction = await serveCorrect(f.kit.ctx, f.args);
    expect(correction.data?.claim_id).toBeString();
    const native = f.db.query<{ event_id: string; occurred_at: string }, []>(
      "SELECT e.event_id,e.occurred_at FROM events e JOIN native_owner_evidence n USING(event_id)",
    ).get()!;
    const { token } = addAgent(f.db, "native-search-reader", {
      ceiling: "personal", subjects: [SUBJECT], types: null, tools: ["search", "context_packet"],
      rate_limit_per_minute: 1000, relay_owner_corrections: false,
    });
    const principal = authenticate(f.db, token)!;
    const assertQuote = async (db: typeof f.db, vaultPath: string, sourceWithdrawn = true) => {
      const ctx = { db, vaultPath, principal: OWNER };
      const found = await serveSearch(ctx, { query: STATEMENT, scope: "ledger" });
      expect(found.quoted).toEqual([expect.objectContaining({ event_id: native.event_id, text: STATEMENT, connector_id: "kizuki.owner", tainted: true })]);
      expect(found.canon).toEqual([]);
      // The recorded instant is inside this explicitly half-open interval.
      const packet = await serveContextPacket(ctx, { query: STATEMENT, purpose: "recall", budget_tokens: 2000,
        until: new Date(Date.parse(native.occurred_at) + 1).toISOString() });
      if (sourceWithdrawn) expect(packet.quoted).toEqual(expect.arrayContaining([expect.objectContaining({ event_id: native.event_id, text: STATEMENT })]));
      return found.quoted;
    };
    const initial = await assertQuote(f.db, f.vault.path, false);
    // Snapshot before revocation: pending erasure correctly blocks a later backup.
    await backupVault(f.db, f.vault.path, join(scratch, "snapshot"));
    const revoke = (db: typeof f.db) => revokeSourceGrant(db, { source_key: f.kit.sourceKey, expected_revision: 1, operation_id: "native-search-withdraw" });
    revoke(f.db);
    expect(await assertQuote(f.db, f.vault.path)).toEqual(initial);
    const hidden = await serveSearch({ db: f.db, vaultPath: f.vault.path, principal }, { query: STATEMENT, scope: "all" });
    expect(hidden.quoted).toEqual([]);
    expect(hidden.canon).toEqual([]);
    const discovery = serveWorldView(f.kit.ctx, { operation: "find_situations", label: "Orchard", valid: { kind: "all" }, knownAt: { kind: "current" } });
    expect(discovery.data).toHaveProperty("result.data.matches", []);
    const oldLabel = await serveSearch(f.kit.ctx, { query: "Orchard", scope: "all" });
    expect(oldLabel.quoted).toEqual([]);
    expect(oldLabel.canon).toEqual([]);
    f.db.close();
    reopened = openLedger(join(f.vault.path, ".kizuki/kizuki.db"));
    expect(await assertQuote(reopened, f.vault.path)).toEqual(initial);
    await rebuildRetrieval(reopened, f.vault.path, undefined, { layer: "search" });
    expect(await assertQuote(reopened, f.vault.path)).toEqual(initial);
    restoreSnapshot(join(scratch, "snapshot"), join(scratch, "restored"));
    restored = openLedger(join(scratch, "restored/.kizuki/kizuki.db"));
    revoke(restored);
    expect(await assertQuote(restored, join(scratch, "restored"))).toEqual(initial);
  } finally {
    restored?.close(); reopened?.close(); f.db.close(); f.vault.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

test("native indexing failure rolls back recording and a retry files one searchable event", async () => {
  const f = await fixture();
  try {
    f.db.exec(`CREATE TRIGGER fail_native_search BEFORE INSERT ON search_documents
      WHEN NEW.scope='ledger' BEGIN SELECT RAISE(ABORT, 'synthetic index failure'); END`);
    await expect(serveCorrect(f.kit.ctx, f.args)).rejects.toThrow("serving failed");
    expect(f.db.query("SELECT count(*) AS n FROM native_owner_evidence").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM events WHERE connector_id='kizuki.owner'").get()).toEqual({ n: 0 });
    f.db.exec("DROP TRIGGER fail_native_search");
    const corrected = await serveCorrect(f.kit.ctx, f.args);
    expect(corrected.data?.claim_id).toBeString();
    expect(f.db.query("SELECT count(*) AS n FROM native_owner_evidence").get()).toEqual({ n: 1 });
    const result = await serveSearch(f.kit.ctx, { query: STATEMENT, scope: "ledger" });
    expect(result.quoted).toEqual([expect.objectContaining({ text: STATEMENT })]);
  } finally { f.db.close(); f.vault.dispose(); }
}, 120_000);

test("duplicate native recording repairs a lost event projection without adding evidence", async () => {
  const f = await fixture();
  try {
    const input = { ...validEvent(), connector_id: "kizuki.owner", source_record_id: "native-search-duplicate",
      text: STATEMENT, sensitivity_hint: "private" as const };
    const first = recordNativeCorrectionEvent(f.db, input, "b".repeat(64));
    expect(first.duplicate).toBe(false);
    removeDoc(f.db, "ledger", first.event_id);
    expect((await serveSearch(f.kit.ctx, { query: STATEMENT, scope: "ledger" })).quoted).toEqual([]);
    expect(recordNativeCorrectionEvent(f.db, input, "b".repeat(64))).toEqual({ event_id: first.event_id, duplicate: true });
    expect(f.db.query("SELECT count(*) AS n FROM native_owner_evidence").get()).toEqual({ n: 1 });
    expect((await serveSearch(f.kit.ctx, { query: STATEMENT, scope: "ledger" })).quoted)
      .toEqual([expect.objectContaining({ event_id: first.event_id, text: STATEMENT })]);
  } finally { f.db.close(); f.vault.dispose(); }
}, 120_000);
