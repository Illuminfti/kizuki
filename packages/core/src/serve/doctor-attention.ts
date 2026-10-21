import type { Database } from "bun:sqlite";
import { OWNER } from "../agents";
import { currentAttention } from "../world/attention/state";
import { attentionDeliverable } from "../world/attention/deliver";
import { withUnissuedWorldReferences } from "../world/references";

export interface AttentionDoctor {
  readonly pending: number;
  readonly pending_capped: boolean;
  readonly delivery_ready: boolean;
  readonly last_delivery_at: string | null;
  readonly detail: string;
}
export function attentionDoctor(db: Database, vaultPath: string, now: string): AttentionDoctor {
  return withUnissuedWorldReferences(db, () => db.transaction(() => {
    const { ns, read } = currentAttention({ db, vaultPath, principal: OWNER }, now);
    const pending = read.entries.filter(entry => entry.candidate.disposition === "none" && entry.deliveredAt === null && entry.candidate.source !== "stale_summary").length;
    const capped = read.data.coverage.gaps.includes("traversal_limit"), ready = attentionDeliverable(read);
    const last = db.query<{ at: string | null }, [string]>("SELECT max(delivered_at) AS at FROM world_attention_state WHERE namespace_id=?").get(ns.id)?.at ?? null;
    return { pending, pending_capped: capped, delivery_ready: ready, last_delivery_at: last,
      detail: `attention: pending${capped ? " at least" : ""}=${pending}; delivery=${ready ? "ready" : "waiting for current coverage"}; last delivery=${last ?? "none"}; channel=file` };
  }).deferred());
}
