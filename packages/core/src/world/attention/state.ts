import type { Database } from "bun:sqlite";
import { OWNER, resolvePrincipal } from "../../agents";
import { rfc3339Millis } from "../../agents/time";
import { validCueKey, type AttentionCandidate } from "../../contracts/attention";
import { ServeError, type ServeContext } from "../../serving/types";
import { activeWorldOps } from "../ops/registry";
import { worldNamespace, type WorldNamespace } from "../references";
import { readAttention, type AttentionEntry, type AttentionRead } from "./read";

export function ownerAttentionContext(ctx: ServeContext): ServeContext {
  if (ctx.principal.kind !== "owner" || resolvePrincipal(ctx.db, ctx.principal)?.kind !== "owner")
    throw new ServeError("tool_not_granted", "attention dispositions require the owner");
  return { ...ctx, principal: OWNER };
}
export function currentAttention(ctx: ServeContext, now: string): { ns: WorldNamespace; read: AttentionRead } {
  const ns = worldNamespace(ctx.db, ctx.principal);
  return { ns, read: readAttention({ ctx, ns, registry: activeWorldOps() }, { kind: "all" }, now) };
}
export function saveAttentionState(db: Database, ns: WorldNamespace, entry: AttentionEntry,
  disposition: AttentionCandidate["disposition"], until: string | null, delivered: string | null, now: string): void {
  if (!db.inTransaction) throw new Error("attention state requires a transaction");
  db.query(`INSERT INTO world_attention_state(namespace_id,cue_key,handle_id,source,disposition,snoozed_until,delivered_at,event_ids,claim_ids,source_keys,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(namespace_id,cue_key) DO UPDATE SET disposition=excluded.disposition,
    snoozed_until=excluded.snoozed_until,delivered_at=excluded.delivered_at,event_ids=excluded.event_ids,
    claim_ids=excluded.claim_ids,source_keys=excluded.source_keys,updated_at=excluded.updated_at`)
    .run(ns.id, entry.candidate.cue, entry.handle, entry.candidate.source, disposition, until, delivered,
      JSON.stringify([...entry.dependencies.events].sort()), JSON.stringify([...entry.dependencies.claims].sort()), JSON.stringify(entry.sources), now);
}
/** Owner-only bookkeeping. No claim, confidence, receipt or canon write is reachable here. */
export function setAttentionDisposition(ctx: ServeContext, cue: unknown, action: "dismiss" | "snooze", until?: unknown): AttentionCandidate {
  const owner = ownerAttentionContext(ctx), now = new Date().toISOString();
  if (!validCueKey(cue) || !["dismiss", "snooze"].includes(action)) throw new ServeError("invalid_arguments", "invalid attention disposition");
  let snoozedUntil: string | null = null;
  if (action === "snooze") {
    let timestamp: number;
    try { if (typeof until !== "string" || until.length > 40) throw new Error(); timestamp = rfc3339Millis(until, "until"); }
    catch { throw new ServeError("invalid_arguments", "snooze requires an RFC3339 time"); }
    if (timestamp <= Date.parse(now) || timestamp > Date.parse(now) + 366 * 86_400_000) throw new ServeError("invalid_arguments", "snooze must end within the next year");
    snoozedUntil = new Date(timestamp).toISOString();
  } else if (until !== undefined) throw new ServeError("invalid_arguments", "dismiss has no end time");
  return ctx.db.transaction(() => {
    const { ns, read } = currentAttention(owner, now), entry = read.entries.find(entry => entry.candidate.cue === cue);
    if (entry === undefined) throw new ServeError("invalid_arguments", "attention candidate is no longer available");
    const disposition: AttentionCandidate["disposition"] = action === "dismiss" ? "dismissed" : "snoozed";
    saveAttentionState(ctx.db, ns, entry, disposition, snoozedUntil, entry.deliveredAt, now);
    return { ...entry.candidate, disposition, snoozedUntil };
  }).immediate();
}
