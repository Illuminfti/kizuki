import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { runBackfill } from "../../src/ingest/run";
import { serveWorldView } from "../../src/serving/world-view";
import type { Attention, AttentionCandidate } from "../../src/contracts/attention";
import { worldSeed, type WorldSeedOptions } from "./world-seed";
import { completeEmptyWorldSummaries, EMPTY_SUMMARY_MODEL } from "./world-consolidation";
import { connector } from "../connections-helpers";
import { tempVault } from "./vault";

export const ATTENTION_WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
export async function attentionFixture(options: { blocker?: boolean; objective?: boolean; complete?: boolean; coverage?: boolean } = {}) {
  const vault = tempVault("kizuki-attention-"), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  async function seed(subject: string, overrides: WorldSeedOptions = {}) {
    const base = await worldSeed(db, { kind: "situation", connector: "fixture", subject, label: subject,
      model: EMPTY_SUMMARY_MODEL, predicates: [
        ...(options.objective === false ? [] : [{ predicate: "situation.objective", object: { kind: "literal" as const, value: "Deliver an independently checked artifact" } }]),
        ...(options.blocker === false ? [] : [{ predicate: "situation.blocker", object: { kind: "literal" as const, value: "Required inspection is blocked" } }]),
      ], ...overrides });
    const ctx = { ...base.ctx, vaultPath: vault.path };
    if (options.coverage !== false) {
      const capture = connector(async () => ({ display: "synthetic" }));
      const manifest = capture.manifest();
      capture.manifest = () => ({ ...manifest, capabilities: { ...manifest.capabilities, backfill: true } });
      capture.backfill = async () => ({ events: [], cursor: "complete", has_more: false });
      const result = await runBackfill(db, capture, "fixture", base.sourceKey);
      if (result.errors.length) throw new Error("synthetic attention coverage failed");
    }
    return { ...base, ctx };
  }
  const situation = await seed("situation:attention");
  if (options.complete !== false) await completeEmptyWorldSummaries(db, vault.path);
  function envelope(ctx = situation.ctx) { return serveWorldView(ctx, { operation: "attention", ...ATTENTION_WHEN }); }
  function read(ctx = situation.ctx): Attention {
    const result = envelope(ctx).data;
    if (!("result" in result) || !("data" in result.result) || result.result.data.schema !== "kizuki.attention/v1") throw new Error("attention fixture read unavailable");
    return result.result.data;
  }
  const candidates = (ctx = situation.ctx) => read(ctx).states.filter((state): state is AttentionCandidate => state.state === "candidate");
  return { db, vault, situation, ctx: situation.ctx, seed, read, envelope, candidates, complete: () => completeEmptyWorldSummaries(db, vault.path), dispose() { db.close(); vault.dispose(); } };
}
