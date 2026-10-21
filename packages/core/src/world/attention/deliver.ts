import type { NotificationReceipt } from "../../contracts/notifier";
import type { ServeContext } from "../../serving/types";
import { validCueKey } from "../../contracts/attention";
import { createFileNotifier } from "../../serve/notifier-file";
import { serializePage } from "../../vault/frontmatter";
import { MAX_FRONTMATTER_ARRAY_ITEMS } from "../../vault/schema";
import { currentAttention, ownerAttentionContext, saveAttentionState } from "./state";
import type { AttentionRead } from "./read";

/** A separate fixed interruption budget, unrelated to model calls or canon writes. */
export const ATTENTION_DELIVERY_LIMIT = 4;
export type AttentionDelivery = { readonly status: "delivered"; readonly receipt: NotificationReceipt }
  | { readonly status: "suppressed" | "unavailable" };
export function attentionDeliverable(read: AttentionRead): boolean {
  return read.data.coverage.status === "complete_for_query" &&
    !read.data.states.some(state => state.state !== "candidate" && state.state !== "quiet");
}
/** Recompute current policy and freshness at the file effect; retry is keyed by cue. */
export async function deliverAttention(ctx: ServeContext, cue: string): Promise<AttentionDelivery> {
  const owner = ownerAttentionContext(ctx);
  if (!validCueKey(cue)) return { status: "unavailable" };
  const notifier = createFileNotifier(ctx.vaultPath), now = new Date().toISOString();
  // The built-in file notifier performs its bounded file effect synchronously,
  // under its normal custody lock, before returning the delivery promise.
  const pending = ctx.db.transaction(() => {
    const { read } = currentAttention(owner, now), entry = read.entries.find(item => item.candidate.cue === cue);
    if (entry === undefined || !attentionDeliverable(read)) return { status: "unavailable" as const };
    if (entry.candidate.disposition !== "none" || entry.candidate.source === "stale_summary") return { status: "suppressed" as const };
    const sources = [...entry.dependencies.events].sort();
    if (sources.length === 0 || sources.length > MAX_FRONTMATTER_ARRAY_ITEMS) return { status: "unavailable" as const };
    const body = serializePage({ data: { id: `rollup:attention-${cue}`, title: "Attention cue", type: "rollup", status: "active", sensitivity: "private", taint: "clean", sources,
      "x-attention-producer": "deterministic", "x-attention-cue": cue },
      body: `# Attention\n\n- ${entry.candidate.source.replaceAll("_", " ")} for an explicit objective. Inspect evidence with \`kizuki attention\`. Cue: ${cue}\n` });
    return notifier.notify({ notification_id: `attention-${cue}`, title: `attention:${entry.candidate.source}`, body, sensitivity: "private", provenance: sources });
  }).immediate();
  const result = await pending;
  if ("status" in result) return result;
  ctx.db.transaction(() => {
    const { ns, read } = currentAttention(owner, new Date().toISOString());
    const entry = read.entries.find(item => item.candidate.cue === cue);
    if (entry !== undefined && attentionDeliverable(read) && entry.candidate.disposition === "none")
      saveAttentionState(ctx.db, ns, entry, "none", null, entry.deliveredAt ?? result.delivered_at, now);
  }).immediate();
  return { status: "delivered", receipt: result };
}
export async function deliverPendingAttention(ctx: ServeContext): Promise<{ delivered: number; duplicate: number; pending: number }> {
  const owner = ownerAttentionContext(ctx);
  const { read } = ctx.db.transaction(() => currentAttention(owner, new Date().toISOString())).immediate();
  const pending = attentionDeliverable(read) ? read.entries.filter(entry => entry.candidate.disposition === "none" && entry.candidate.source !== "stale_summary" && entry.deliveredAt === null) : [];
  let delivered = 0, duplicate = 0;
  for (const entry of pending.slice(0, ATTENTION_DELIVERY_LIMIT)) {
    const result = await deliverAttention(owner, entry.candidate.cue);
    if (result.status === "delivered") { if (result.receipt.duplicate) duplicate += 1; else delivered += 1; }
  }
  return { delivered, duplicate, pending: Math.max(0, pending.length - delivered - duplicate) };
}
