import type { Database } from "bun:sqlite";
import { serveWorldView } from "../../src/serving/world-view";
import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { serveCorrect } from "../../src/serving/correct";
import { undoReceipt } from "../../src/canon/undo";
import { correctionKit, worldData } from "../helpers/world-correct-kit";
import { tempVault } from "../helpers/vault";
import { OWNER_AGENT_GRANT, addAgent, authenticate, setGrant } from "../../src/agents";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { rebuildWorldLayer } from "../../src/derived";
import { purgeEvents } from "../../src/ledger/purge";
import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import { exportVault, restoreVault } from "../../src/export";
import { correct } from "../../src/correction/correct";
import { createBudgetTracker } from "../../src/canon/budget";
import { cardFixture } from "../world/card-fixture";
import { revokeSourceGrant } from "../../src/ledger/source-grants";

setDefaultTimeout(120_000);

async function scene() {
  const vault = tempVault(), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  const kit = correctionKit(db, vault.path);
  await kit.declare("concept", "topic:a", "First identity label");
  await kit.declare("concept", "topic:b", "Second identity label");
  await kit.write({ subject: "topic:a", predicate: "concept.definition", object: { literal: "First definition" } });
  await kit.write({ subject: "topic:b", predicate: "concept.definition", object: { literal: "Second definition" } });
  kit.materialize("topic:a"); kit.materialize("topic:b");
  const a = kit.find(kit.ctx, "concept", "First"), b = kit.find(kit.ctx, "concept", "Second");
  const matches = () => worldData(kit.read(kit.ctx, { operation: "find_concepts", label: "", valid: { kind: "all" }, knownAt: { kind: "current" } })).matches;
  return { vault, db, kit, a, b, matches, dispose() { db.close(); vault.dispose(); } };
}

test("owner identity correction merges, preserves requested anchor and is receipt-reversible", async () => {
  const s = await scene();
  try {
    expect(s.matches()).toHaveLength(2);
    const before = s.kit.card(s.kit.ctx, "concept", s.a);
    const result = await serveCorrect(s.kit.ctx, {
      target: { world_claim: before.concept.classificationClaims[0] },
      mode: "merge_identity",
      object: { kind: "node", ref: s.b },
      statement: "These are the same concept.",
    });
    expect(result.data?.superseded).toHaveLength(0);
    expect(s.matches()).toHaveLength(1);
    const card = s.kit.card(s.kit.ctx, "concept", s.a);
    expect(card.concept.ref).toEqual(s.a);
    expect(card.concept.resolution).toBe("resolved");
    expect(card.concept.labels.map((x: any) => x.text).sort()).toEqual(["First identity label", "Second identity label"]);
    expect(card.definitions).toHaveLength(2);
    expect(s.kit.card(s.kit.ctx, "concept", s.b).concept.ref).toEqual(s.b);
    expect(result.data?.receipt_id).toBeString();
    await undoReceipt({ db: s.db, vault_path: s.vault.path }, result.data!.receipt_id!);
    expect(s.matches()).toHaveLength(2);
  } finally { s.dispose(); }
});

test("one source identity candidate remains ambiguous without merging", async () => {
  const s = await scene();
  try {
    await s.kit.write({ subject: "topic:a", predicate: "concept.same_as", object: { subject: "topic:b" } });
    expect(s.matches()).toHaveLength(2);
    expect(s.kit.card(s.kit.ctx, "concept", s.a).concept.resolution).toBe("ambiguous");
  } finally { s.dispose(); }
});

test("owner separation blocks a merge, replay is idempotent and undo restores the cluster", async () => {
  const s = await scene();
  try {
    const target = { world_claim: s.kit.card(s.kit.ctx, "concept", s.a).concept.classificationClaims[0] };
    const object = { kind: "node" as const, ref: s.b };
    await serveCorrect(s.kit.ctx, { target, object, mode: "merge_identity", statement: "The two names refer to one concept." });
    const request = { target, object, mode: "separate_identity" as const, statement: "These are distinct concepts." };
    const separate = await serveCorrect(s.kit.ctx, request);
    expect(s.matches()).toHaveLength(2);
    expect(s.kit.card(s.kit.ctx, "concept", s.a).concept.resolution).toBe("ambiguous");
    const replay = await serveCorrect(s.kit.ctx, request);
    expect(replay.data?.event_id).toBe(separate.data?.event_id);
    expect(replay.data?.claim_id).toBe(separate.data?.claim_id);
    const semantic = readClaimV2Semantic(s.db, separate.data!.claim_id!);
    expect(semantic?.discriminator === "assertion" && semantic.predicate).toBe("concept.same_as");
    await undoReceipt({ db: s.db, vault_path: s.vault.path }, separate.data!.receipt_id!);
    expect(s.matches()).toHaveLength(1);
    rebuildWorldLayer(s.db);
    expect(s.matches()).toHaveLength(1);
  } finally { s.dispose(); }
});

test("a hidden intermediate concept and owner merge change no scoped bytes or work", async () => {
  const s = await scene();
  try {
    const enrolled = addAgent(s.db, "identity-scoped", { ...OWNER_AGENT_GRANT, subjects: ["topic:a", "topic:b"] });
    const principal = authenticate(s.db, enrolled.token)!;
    const ctx = { ...s.kit.ctx, principal };
    const ref = s.kit.find(ctx, "concept", "First");
    const read = () => collectReadFrames(() => s.kit.card(ctx, "concept", ref));
    const before = read();
    await s.kit.declare("concept", "topic:hidden", "Hidden connector");
    const hidden = s.kit.find(s.kit.ctx, "concept", "Hidden");
    for (const own of [s.a, s.b]) await serveCorrect(s.kit.ctx, {
      target: { world_claim: s.kit.card(s.kit.ctx, "concept", own).concept.classificationClaims[0] },
      mode: "merge_identity", object: { kind: "node", ref: hidden }, statement: `This visible concept and the hidden concept coincide: ${own.token.slice(0, 4)}.`,
    });
    const after = read();
    expect(after.result).toEqual(before.result);
    expect(after.frames.map(f => f.stats)).toEqual(before.frames.map(f => f.stats));
    expect(s.matches()).toHaveLength(1);
    const scoped = worldData(s.kit.read(ctx, { operation: "find_concepts", label: "", valid: { kind: "all" }, knownAt: { kind: "current" } }));
    expect(scoped.matches).toHaveLength(2);
  } finally { s.dispose(); }
});

test("ordinary correction clients cannot mint owner identity assertions", async () => {
  const s = await scene();
  try {
    const enrolled = addAgent(s.db, "identity-no-relay", { ...OWNER_AGENT_GRANT, relay_owner_corrections: false });
    const ctx = { ...s.kit.ctx, principal: authenticate(s.db, enrolled.token)! };
    const a = s.kit.find(ctx, "concept", "First"), b = s.kit.find(ctx, "concept", "Second");
    const count = () => s.db.query<{ n: number }, []>("SELECT count(*) n FROM native_owner_evidence").get()!.n;
    const before = count();
    await expect(serveCorrect(ctx, {
      target: { world_claim: s.kit.card(ctx, "concept", a).concept.classificationClaims[0] },
      mode: "merge_identity", object: { kind: "node", ref: b }, statement: "Treat these as the same.",
    })).rejects.toThrow("correction relay is not granted");
    expect(count()).toBe(before);
    expect(s.matches()).toHaveLength(2);
  } finally { s.dispose(); }
});

test("purging native identity evidence splits the next read without reconstructing it", async () => {
  const s = await scene();
  try {
    const merged = await serveCorrect(s.kit.ctx, {
      target: { world_claim: s.kit.card(s.kit.ctx, "concept", s.a).concept.classificationClaims[0] },
      mode: "merge_identity", object: { kind: "node", ref: s.b }, statement: "These concepts share identity.",
    });
    expect(s.matches()).toHaveLength(1);
    purgeEvents(s.db, s.vault.path, { event_id: merged.data!.event_id! }, "Remove synthetic identity evidence");
    expect(s.matches()).toHaveLength(2);
    rebuildWorldLayer(s.db);
    expect(s.matches()).toHaveLength(2);
  } finally { s.dispose(); }
});

test("the first owner merge creates an undoable page and survives backup restore", async () => {
  const vault = tempVault(), output = tempVault(), destination = tempVault();
  const db = openLedger(join(vault.path, ".kizuki/kizuki.db")), kit = correctionKit(db, vault.path);
  try {
    await kit.declare("concept", "topic:one", "Unmaterialized one");
    await kit.declare("concept", "topic:two", "Unmaterialized two");
    const a = kit.find(kit.ctx, "concept", "one"), b = kit.find(kit.ctx, "concept", "two");
    const result = await serveCorrect(kit.ctx, {
      target: { world_claim: kit.card(kit.ctx, "concept", a).concept.classificationClaims[0] },
      mode: "merge_identity", object: { kind: "node", ref: b }, statement: "These two concepts are identical.",
    });
    // The caller owns its new statement even when no old page existed.
    expect(result.data?.receipt_id).toBeString();
    const backup = join(output.path, "backup"), restored = join(destination.path, "restored");
    await exportVault(db, vault.path, backup); restoreVault(backup, restored);
    const copy = openLedger(join(restored, ".kizuki/kizuki.db"));
    try {
      const read = correctionKit(copy, restored, { source: { connector: "world.correct", sourceKey: kit.sourceKey } });
      const ref = read.find(read.ctx, "concept", "one");
      expect(read.card(read.ctx, "concept", ref).concept.resolution).toBe("resolved");
    } finally { copy.close(); }
    await undoReceipt({ db, vault_path: vault.path }, result.data!.receipt_id!);
    expect(kit.card(kit.ctx, "concept", a).concept.resolution).toBe("distinct");
  } finally { db.close(); vault.dispose(); output.dispose(); destination.dispose(); }
});

test("failed first materialization leaves identity inactive and retry uses the same statement", async () => {
  const vault = tempVault(), db = openLedger(join(vault.path, ".kizuki/kizuki.db")), kit = correctionKit(db, vault.path);
  try {
    const declared = await kit.declare("concept", "topic:first", "First pending concept");
    await kit.declare("concept", "topic:last", "Last pending concept");
    const request = { statement: "These names mean the same concept.", target: { claim_id: declared[0]! },
      world: { mode: "merge_identity" as const, object: { kind: "subject" as const, ref: kit.ref("topic:last") } } };
    await expect(correct({ db, vault_path: vault.path, budget: createBudgetTracker({ canon_writes_per_run: 1 }) }, request)).rejects.toThrow();
    const pending = db.query<{ event_id: string }, []>("SELECT event_id FROM native_owner_evidence").all();
    expect(pending).toHaveLength(1);
    const ref = kit.find(kit.ctx, "concept", "First pending");
    expect(kit.card(kit.ctx, "concept", ref).concept.resolution).toBe("distinct");
    const recovered = await correct({ db, vault_path: vault.path }, request);
    expect(recovered.event_id).toBe(pending[0]!.event_id);
    expect(recovered.receipt_id).toBeString();
    expect(kit.card(kit.ctx, "concept", ref).concept.resolution).toBe("resolved");
    await undoReceipt({ db, vault_path: vault.path }, recovered.receipt_id!);
    expect(kit.card(kit.ctx, "concept", ref).concept.resolution).toBe("distinct");
  } finally { db.close(); vault.dispose(); }
});

test("an oversized identity frontier is partial and an owner merge refuses before evidence", async () => {
  const db = openLedger(":memory:"), f = await cardFixture(db);
  try {
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } }, { subject: "topic:other" });
    await f.write("concept.label", { kind: "literal", value: "Other concept" }, { subject: "topic:other" });
    for (let index = 0; index < 1025; index++) await f.write("concept.same_as", { kind: "subject", ref: f.ref("topic:other") }, {
      mode: "hypothetical", from: new Date(Date.UTC(2026, 0, 1) + index).toISOString(), text: `Hypothetical identity candidate ${index}.`,
    });
    const before = worldData(correctionKit(db, f.ctx.vaultPath, { source: { connector: "card.fixture", sourceKey: f.sourceKey } }).read(f.ctx, f.input("find_concepts", { label: "" })));
    expect(before.matches).toHaveLength(2);
    expect(before.coverage.gaps).not.toContain("traversal_limit");
    for (let index = 0; index < 1025; index++) await f.write("concept.same_as", { kind: "subject", ref: f.ref("topic:other") }, {
      from: new Date(Date.UTC(2026, 0, 1) + index).toISOString(), text: `Synthetic identity candidate ${index}.`,
    });
    const card = f.card();
    expect(card.concept.resolution).toBe("ambiguous");
    expect(card.coverage.status).toBe("partial");
    expect(card.coverage.gaps).toContain("traversal_limit");
    const kit = correctionKit(db, f.ctx.vaultPath, { source: { connector: "card.fixture", sourceKey: f.sourceKey } });
    const other = kit.find(kit.ctx, "concept", "Other concept");
    const evidenceBefore = db.query<{ n: number }, []>("SELECT count(*) n FROM native_owner_evidence").get()!.n;
    await expect(serveCorrect(f.ctx, { target: { world_claim: card.concept.classificationClaims[0]! },
      mode: "merge_identity", object: { kind: "node", ref: other }, statement: "Merge this bounded component." })).rejects.toThrow("traversal bounds");
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM native_owner_evidence").get()!.n).toBe(evidenceBefore);
  } finally { db.close(); f.dispose(); }
});


test("historical identity never borrows a later receipt and survives later undo", async () => {
  const s = await scene();
  try {
    const at = "2031-01-01T00:00:00.000Z";
    s.db.query("UPDATE claim_history_clock SET last_recorded_at=?").run(at);
    const input = (knownAt: unknown) => ({ operation: "concept", concept: s.a, valid: { kind: "all" }, knownAt });
    const before = worldData(s.kit.read(s.kit.ctx, input({ kind: "time", at })));
    // The existing page means a zero budget fails after filing the identity claim.
    const target = s.db.query<{ claim_id: string }, []>("SELECT claim_id FROM claim_v2_semantics WHERE predicate='world.kind' ORDER BY claim_id LIMIT 1").get()!;
    const request = { statement: "Historical identity assertion.", target, world: { mode: "merge_identity" as const, object: { kind: "subject" as const, ref: s.kit.ref("topic:b") } } };
    await expect(correct({ db: s.db, vault_path: s.vault.path, budget: createBudgetTracker({ canon_writes_per_run: 0 }) }, request)).rejects.toThrow();
    const filed = worldData(s.kit.read(s.kit.ctx, input({ kind: "time", at })));
    expect(filed.concept.resolution).toBe("distinct");
    const merged = await correct({ db: s.db, vault_path: s.vault.path }, request);
    expect(merged.receipt_id).toBeString();
    const committed = worldData(s.kit.read(s.kit.ctx, input({ kind: "time", at })));
    expect(committed.concept.resolution).toBe("resolved");
    expect(worldData(s.kit.read(s.kit.ctx, input(filed.knownAt))).concept.resolution).toBe("distinct");
    expect(worldData(s.kit.read(s.kit.ctx, input(before.knownAt))).concept.resolution).toBe("distinct");
    await undoReceipt({ db: s.db, vault_path: s.vault.path }, merged.receipt_id!);
    expect(s.kit.card(s.kit.ctx, "concept", s.a).concept.resolution).toBe("distinct");
    expect(worldData(s.kit.read(s.kit.ctx, input(committed.knownAt))).concept.resolution).toBe("resolved");
  } finally { s.dispose(); }
});

test("cross-source owner identity splits immediately when endpoint consent is revoked", async () => {
  const s = await scene();
  try {
    const other = correctionKit(s.db, s.vault.path);
    await other.declare("concept", "topic:foreign", "Foreign endpoint");
    const b = other.find(s.kit.ctx, "concept", "Foreign endpoint");
    const merged = await serveCorrect(s.kit.ctx, { target: { world_claim: s.kit.card(s.kit.ctx, "concept", s.a).concept.classificationClaims[0] },
      mode: "merge_identity", object: { kind: "node", ref: b }, statement: "The foreign endpoint is the same concept." });
    expect(merged.data?.receipt_id).toBeString();
    expect(s.kit.card(s.kit.ctx, "concept", s.a).concept.resolution).toBe("resolved");
    revokeSourceGrant(s.db, { source_key: other.sourceKey, expected_revision: 1, operation_id: "identity-revoke-endpoint" });
    expect(s.kit.card(s.kit.ctx, "concept", s.a).concept.resolution).toBe("distinct");
    expect(other.read(s.kit.ctx, { operation: "concept", concept: b, valid: { kind: "all" }, knownAt: { kind: "current" } })).toEqual({ status: "not_found" });
  } finally { s.dispose(); }
});

test("grant narrowing splits an owner component for that principal alone", async () => {
  const s = await scene();
  try {
    await serveCorrect(s.kit.ctx, { target: { world_claim: s.kit.card(s.kit.ctx, "concept", s.a).concept.classificationClaims[0] },
      mode: "merge_identity", object: { kind: "node", ref: s.b }, statement: "Merge for scoped read." });
    const agent = addAgent(s.db, "identity-narrow", OWNER_AGENT_GRANT);
    const ctx = { ...s.kit.ctx, principal: authenticate(s.db, agent.token)! };
    const ref = s.kit.find(ctx, "concept", "First");
    expect(s.kit.card(ctx, "concept", ref).concept.resolution).toBe("resolved");
    setGrant(s.db, "identity-narrow", { subjects: ["topic:a"] });
    const narrowed = { ...ctx, principal: authenticate(s.db, agent.token)! };
    const now = s.kit.find(narrowed, "concept", "First");
    expect(s.kit.card(narrowed, "concept", now).concept.resolution).toBe("distinct");
    expect(s.kit.card(s.kit.ctx, "concept", s.a).concept.resolution).toBe("resolved");
  } finally { s.dispose(); }
});

test("equal names, quoted nominations and copied witnesses do not manufacture identity", async () => {
  const db = openLedger(":memory:"), f = await cardFixture(db);
  try {
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } }, { subject: "topic:other" });
    await f.write("concept.label", { kind: "literal", value: "Bayesian updating" }, { subject: "topic:other" });
    expect(f.card().concept.resolution).toBe("distinct");
    const object = { kind: "subject" as const, ref: f.ref("topic:other") };
    await f.write("concept.same_as", object, { mode: "quoted", speaker: "person:speaker" });
    expect(f.card().concept.resolution).toBe("distinct");
    await f.write("concept.distinguished_from", object, { polarity: "negative" });
    expect(f.card().concept.resolution).toBe("distinct");
    await f.write("concept.same_as", object, { text: "An identity nomination" });
    await f.write("concept.same_as", object, { text: "An identity nomination", metadata: { copy_of: "earlier witness" } });
    expect(f.card().concept.resolution).toBe("ambiguous");
    const data = worldData(correctionKit(db, f.ctx.vaultPath, { source: { connector: "card.fixture", sourceKey: f.sourceKey } }).read(f.ctx, f.input("find_concepts", { label: "Bayesian" })));
    expect(data.matches).toHaveLength(2);
  } finally { f.dispose(); db.close(); }
});


test("historical grouping refuses a member whose retained classification coverage was reset", async () => {
  const s = await scene();
  try {
    const at = "2032-01-01T00:00:00.000Z";
    s.db.query("UPDATE claim_history_clock SET last_recorded_at=?").run(at);
    const classification = await s.kit.write({ subject: "topic:b", predicate: "world.kind", object: { vocabulary: "world/concept" } });
    const events = s.db.query<{ event_id: string }, [string]>("SELECT se.event_id FROM claim_v2_support s JOIN claim_v2_support_events se USING(support_key) WHERE s.claim_id=? ORDER BY se.event_id").all(classification);
    expect(events.length).toBeGreaterThan(1);
    await serveCorrect(s.kit.ctx, { target: { world_claim: s.kit.card(s.kit.ctx, "concept", s.a).concept.classificationClaims[0] },
      mode: "merge_identity", object: { kind: "node", ref: s.b }, statement: "Same concept with retained endpoint evidence." });
    const input = { operation: "concept", concept: s.a, valid: { kind: "all" }, knownAt: { kind: "time", at } };
    expect(worldData(s.kit.read(s.kit.ctx, input)).concept.resolution).toBe("resolved");
    s.db.query("UPDATE claim_history_clock SET last_recorded_at=?").run("2032-01-02T00:00:00.000Z");
    purgeEvents(s.db, s.vault.path, { event_id: events[0]!.event_id }, "Erase one endpoint-classification witness");
    expect(s.kit.card(s.kit.ctx, "concept", s.a).concept.resolution).toBe("resolved");
    expect(s.kit.read(s.kit.ctx, input)).toMatchObject({ result: { status: "unavailable", reason: "history" } });
    const retained = worldData(s.kit.read(s.kit.ctx, { ...input, knownAt: { kind: "time", at: "2032-01-02T00:00:00.000Z" } }));
    expect(retained.concept.resolution).toBe("resolved");
    expect(retained.coverage.history).toBe("baseline_only");
  } finally { s.dispose(); }
});


test("final publication refuses a stale merge after its receipt disappears", async () => {
  const s = await scene();
  try {
    const merged = await serveCorrect(s.kit.ctx, { target: { world_claim: s.kit.card(s.kit.ctx, "concept", s.a).concept.classificationClaims[0] },
      mode: "merge_identity", object: { kind: "node", ref: s.b }, statement: "Receipt-dependent identity." });
    let fired = false;
    const db = new Proxy(s.db, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "transaction") return (run: () => unknown) => {
        const tx = target.transaction(run), finish = (result: unknown) => {
          if (!fired && !target.inTransaction && result !== null && typeof result === "object" && "withheld" in result) {
            fired = true;
            // Storage-loss fault after first-read bytes, before final authority.
            target.query("DELETE FROM canon_receipts WHERE receipt_id=?").run(merged.data!.receipt_id!);
          }
          return result;
        };
        return Object.assign(() => finish(tx()), { immediate: () => finish(tx.immediate()) });
      };
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Database;
    const result = serveWorldView({ ...s.kit.ctx, db }, { operation: "concept", concept: s.a, valid: { kind: "all" }, knownAt: { kind: "current" } });
    expect(fired).toBe(true);
    expect(worldData(result.data).concept.resolution).toBe("distinct");
  } finally { s.dispose(); }
});
