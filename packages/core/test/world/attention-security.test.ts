import { expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAgent, authenticate, OWNER, OWNER_AGENT_GRANT } from "../../src/agents";
import { markClaimReverted } from "../../src/claims/store";
import { rebuildWorldLayer } from "../../src/derived";
import { exportVault, restoreVault } from "../../src/export";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../src/ledger/db";
import { purgeEvents, runPurge } from "../../src/ledger/purge";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { attentionDoctor } from "../../src/serve/doctor-attention";
import { serveWorldView } from "../../src/serving/world-view";
import { deliverAttention, deliverPendingAttention } from "../../src/world/attention/deliver";
import { currentAttention, setAttentionDisposition } from "../../src/world/attention/state";
import { resolveWorldObject, withUnissuedWorldReferences } from "../../src/world/references";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { ATTENTION_TABLE_SPECS } from "../../src/world/tables/attention";
import { attentionFixture, ATTENTION_WHEN } from "../helpers/attention-fixture";

test("scoped attention ignores hidden changes and owner dispositions without extra work", async () => {
  const f = await attentionFixture();
  try {
    const agent = addAgent(f.db, "attention-reader", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["situation:attention"] });
    const ctx = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const observe = () => collectReadFrames(() => serveWorldView(ctx, { operation: "attention", ...ATTENTION_WHEN }).data);
    observe(); await f.complete();
    const before = observe(), readerCue = f.candidates(ctx)[0]!, ownerCue = f.candidates()[0]!;
    expect(readerCue.cue).not.toBe(ownerCue.cue);
    setAttentionDisposition(f.ctx, ownerCue.cue, "dismiss");
    expect(f.candidates(ctx)[0]!.disposition).toBe("none");
    expect(() => setAttentionDisposition(ctx, readerCue.cue, "dismiss")).toThrow("require the owner");
    await expect(deliverAttention(ctx, readerCue.cue)).rejects.toThrow("require the owner");
    await f.seed("situation:hidden", { floor: "private", label: "Private urgent blocker" });
    await f.complete();
    const after = observe();
    expect(after.result).toEqual(before.result);
    expect(after.frames.map(frame => frame.stats)).toEqual(before.frames.map(frame => frame.stats));
    expect(JSON.stringify(after.result)).not.toContain("Private urgent blocker");
    expect(f.candidates()).toHaveLength(2);
  } finally { f.dispose(); }
}, 120_000);

test.each(["revoke", "correct", "purge"])("%s revalidates a queued cue and erases its disposition", async cause => {
  const f = await attentionFixture();
  try {
    const cue = f.candidates()[0]!.cue;
    setAttentionDisposition(f.ctx, cue, "dismiss");
    if (cause === "revoke") revokeSourceGrant(f.db, { source_key: f.situation.sourceKey, expected_revision: 1, operation_id: "attention-revoke" });
    else if (cause === "correct") markClaimReverted(f.db, f.situation.claims[3]!, new Date().toISOString());
    else purgeEvents(f.db, f.vault.path, { event_id: f.situation.eventId }, "erase attention source");
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM world_attention_state").get()!.n).toBe(0);
    expect(await deliverAttention(f.ctx, cue)).toEqual({ status: "unavailable" });
    expect(existsSync(join(f.vault.path, "dashboards", `attention-${cue}.md`))).toBe(false);
  } finally { f.dispose(); }
}, 120_000);

test("purge erases a delivered cue file and bookkeeping while doctor reports current delivery", async () => {
  const f = await attentionFixture();
  try {
    const cue = f.candidates()[0]!.cue, path = join(f.vault.path, "dashboards", `attention-${cue}.md`);
    expect(attentionDoctor(f.db, f.vault.path, new Date().toISOString())).toMatchObject({ pending: 1, last_delivery_at: null, delivery_ready: true });
    expect(await deliverPendingAttention(f.ctx)).toMatchObject({ delivered: 1, pending: 0 });
    expect(attentionDoctor(f.db, f.vault.path, new Date().toISOString())).toMatchObject({ pending: 0, last_delivery_at: expect.any(String) });
    expect(existsSync(path)).toBe(true);
    await runPurge(f.db, f.vault.path, { event_id: f.situation.eventId }, "erase delivered attention source");
    const erased = parseFrontmatter(readFileSync(path, "utf8"));
    expect(erased.data.status).toBe("archived");
    expect(erased.data.sources).toEqual([]);
    expect(erased.body.trim()).toBe("");
    expect(erased.data["x-attention-cue"]).toBeUndefined();
    expect(erased.data["x-attention-producer"]).toBeUndefined();
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM world_attention_state").get()!.n).toBe(0);
    expect(attentionDoctor(f.db, f.vault.path, new Date().toISOString())).toMatchObject({ pending: 0, last_delivery_at: null });
  } finally { f.dispose(); }
}, 120_000);

test.each(["appended", "between heading and cue"])("purge preserves owner prose %s while removing the generated cue", async placement => {
  const f = await attentionFixture();
  try {
    const cue = f.candidates()[0]!.cue, path = join(f.vault.path, "dashboards", `attention-${cue}.md`);
    expect(await deliverAttention(f.ctx, cue)).toMatchObject({ status: "delivered" });
    const ownerNote = "Owner note: take a walk after lunch.", before = readFileSync(path, "utf8");
    writeFileSync(path, placement === "appended" ? `${before}\n${ownerNote}\n` : before.replace("# Attention\n", `# Attention\n\n${ownerNote}\n`));
    await runPurge(f.db, f.vault.path, { event_id: f.situation.eventId }, "erase cue while preserving owner prose");
    const erased = parseFrontmatter(readFileSync(path, "utf8"));
    expect(erased.body).toContain(ownerNote);
    expect(erased.body).not.toContain("for an explicit objective");
    expect(erased.body).not.toContain(cue);
    expect(erased.data["x-attention-cue"]).toBeUndefined();
    expect(erased.data["x-attention-producer"]).toBeUndefined();
    expect(erased.data.sources).toEqual([]);
    expect(erased.data.status).toBe("active");
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM world_attention_state").get()!.n).toBe(0);
  } finally { f.dispose(); }
}, 120_000);

test("snooze expires without rewriting factual evidence", async () => {
  const f = await attentionFixture();
  try {
    const cue = f.candidates()[0]!.cue, now = Date.now(), until = new Date(now + 3600_000).toISOString();
    const before = f.db.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all();
    setAttentionDisposition(f.ctx, cue, "snooze", until);
    expect(f.candidates()[0]!.disposition).toBe("snoozed");
    setSystemTime(new Date(now + 3600_001));
    expect(f.candidates()[0]!).toMatchObject({ disposition: "none", snoozedUntil: null });
    expect(await deliverPendingAttention(f.ctx)).toMatchObject({ delivered: 1 });
    expect(f.db.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all()).toEqual(before);
  } finally { setSystemTime(); f.dispose(); }
}, 120_000);

test("attention bookkeeping survives real export, restore and world rebuild", async () => {
  const f = await attentionFixture(), root = mkdtempSync(join(tmpdir(), "attention-recovery-"));
  try {
    const cue = f.candidates()[0]!.cue;
    await deliverAttention(f.ctx, cue);
    setAttentionDisposition(f.ctx, cue, "dismiss");
    const rows = () => f.db.query("SELECT * FROM world_attention_state ORDER BY cue_key").all(), before = rows();
    rebuildWorldLayer(f.db);
    expect(rows()).toEqual(before);
    exportVault(f.db, f.vault.path, join(root, "backup"));
    restoreVault(join(root, "backup"), join(root, "restored"));
    const restored = openLedger(join(root, "restored/.kizuki/kizuki.db"));
    try {
      expect(restored.query("SELECT * FROM world_attention_state ORDER BY cue_key").all()).toEqual(before);
      const ctx = { db: restored, vaultPath: join(root, "restored"), principal: OWNER };
      expect(f.read(ctx).states).toContainEqual(expect.objectContaining({ cue, disposition: "dismissed" }));
      expect(await deliverPendingAttention(ctx)).toMatchObject({ delivered: 0 });
    } finally { restored.close(); }
  } finally { f.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test("the schema preceding the attention migration upgrades with its triggers and preserves ledger facts", async () => {
  const f = await attentionFixture();
  try {
    const path = join(f.vault.path, ".kizuki/kizuki.db"), before = f.db.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all();
    const erasure = ATTENTION_TABLE_SPECS[0]!.erasure;
    if (erasure.via !== "trigger") throw new Error("attention erasure trigger missing");
    for (const trigger of erasure.triggers) f.db.exec(`DROP TRIGGER ${trigger}`);
    f.db.exec("DROP TABLE world_attention_state");
    f.db.query("UPDATE schema_version SET version=?").run(ATTENTION_TABLE_SPECS[0]!.since - 1);
    const upgraded = openLedger(path);
    try {
      expect(upgraded.query("SELECT version FROM schema_version").get()).toEqual({ version: LEDGER_SCHEMA_VERSION });
      expect(upgraded.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all()).toEqual(before);
      expect(upgraded.query<{ n: number }, []>("SELECT count(*) n FROM world_attention_state").get()!.n).toBe(0);
    } finally { upgraded.close(); }
  } finally { f.dispose(); }
}, 120_000);

test("read-only doctor computes pending cues without issuing persistent references", async () => {
  const f = await attentionFixture();
  try {
    f.db.exec("DELETE FROM world_authorization_namespaces");
    const before = f.db.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all();
    const readonly = new Database(join(f.vault.path, ".kizuki/kizuki.db"), { readonly: true });
    try {
      expect(attentionDoctor(readonly, f.vault.path, new Date().toISOString())).toMatchObject({ pending: 1, last_delivery_at: null });
      expect(readonly.query<{ n: number }, []>("SELECT count(*) n FROM world_authorization_namespaces").get()!.n).toBe(0);
      expect(readonly.query<{ n: number }, []>("SELECT count(*) n FROM world_wire_refs").get()!.n).toBe(0);
    } finally { readonly.close(); }
    expect(f.db.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all()).toEqual(before);
  } finally { f.dispose(); }
}, 120_000);

test("diagnostic reference tokens cannot resolve or be shared after their synchronous scope", async () => {
  const f = await attentionFixture();
  try {
    f.db.exec("DELETE FROM world_authorization_namespaces");
    const agent = addAgent(f.db, "diagnostic-ref-reader", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["situation:attention"] });
    const ctx = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const preview = withUnissuedWorldReferences(f.db, () => f.db.transaction(() => {
      const owner = currentAttention(f.ctx, new Date().toISOString()), scoped = currentAttention(ctx, new Date().toISOString());
      const ref = owner.read.entries[0]!.candidate.subject;
      expect(resolveWorldObject(f.db, owner.ns, ref.token)).not.toBeNull();
      expect(resolveWorldObject(f.db, scoped.ns, ref.token)).toBeNull();
      return { ns: owner.ns, ref };
    }).deferred());
    expect(resolveWorldObject(f.db, preview.ns, preview.ref.token)).toBeNull();
    for (const reader of [f.ctx, ctx]) {
      expect(serveWorldView(reader, { operation: "situation", situation: preview.ref, ...ATTENTION_WHEN }).data).toEqual({ status: "not_found" });
      expect(serveWorldView(reader, { operation: "share", of: { operation: "situation", situation: preview.ref }, ...ATTENTION_WHEN }).data).toEqual({ status: "not_found" });
    }
    const current = f.candidates()[0]!.subject;
    expect(current.token).not.toBe(preview.ref.token);
  } finally { f.dispose(); }
}, 120_000);
