import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { serveCorrect } from "../../src/serving/correct";
import { undoReceipt } from "../../src/canon/undo";
import { correctionKit, worldData } from "../helpers/world-correct-kit";
import { tempVault } from "../helpers/vault";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { rebuildWorldLayer } from "../../src/derived";
import { purgeEvents } from "../../src/ledger/purge";
import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import { exportVault, restoreVault } from "../../src/export";
import { correct } from "../../src/correction/correct";
import { createBudgetTracker } from "../../src/canon/budget";
import { cardFixture } from "../world/card-fixture";

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
      from: new Date(Date.UTC(2026, 0, 1) + index).toISOString(), text: `Synthetic identity candidate ${index}.`,
    });
    const card = f.card();
    expect(card.concept.resolution).toBe("ambiguous");
    expect(card.coverage.status).toBe("partial");
    expect(card.coverage.gaps).toContain("traversal_limit");
    const kit = correctionKit(db, f.ctx.vaultPath, { source: { connector: "card.fixture", sourceKey: f.sourceKey } });
    const other = kit.find(kit.ctx, "concept", "Other concept");
    const before = db.query<{ n: number }, []>("SELECT count(*) n FROM native_owner_evidence").get()!.n;
    await expect(serveCorrect(f.ctx, { target: { world_claim: card.concept.classificationClaims[0]! },
      mode: "merge_identity", object: { kind: "node", ref: other }, statement: "Merge this bounded component." })).rejects.toThrow("traversal bounds");
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM native_owner_evidence").get()!.n).toBe(before);
  } finally { db.close(); f.dispose(); }
});
