import { expect } from "bun:test";
import { join } from "node:path";
import { openLedger } from "@kizuki/core/testing";
import { goldenApp, WHEN, world } from "./golden-app";
import type { StdioClient } from "./two-clients";

/** Owner notification preferences are exercised through App/CLI, never through ledger edits. */
export async function attentionStage(f: Awaited<ReturnType<typeof goldenApp>>, owner: StdioClient, peer: StdioClient) {
  const ownerRead = (await world(owner, { operation: "attention" })).result.data;
  expect(ownerRead.schema).toBe("kizuki.attention/v1");
  const cue = ownerRead.states.find((row: any) => row.state === "candidate" && row.source === "uncertainty");
  expect(cue, JSON.stringify(ownerRead)).toBeDefined(); expect(cue.disposition).toBe("none");
  const peerRead = (await world(peer, { operation: "attention" })).result.data;
  const peerCue = peerRead.states.find((row: any) => row.state === "candidate" && row.source === "uncertainty");
  expect(peerCue).toBeDefined(); expect(peerCue.cue).not.toBe(cue.cue);
  const before = (await world(owner, { operation: "situation", situation: cue.subject, card: "kizuki.situation-card/v2" })).result.data;
  const db = openLedger(join(f.vault, ".kizuki/kizuki.db"));
  try {
    const truth = () => ({ claims: db.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all(),
      supports: db.query("SELECT support_key,admission FROM claim_v2_support ORDER BY support_key").all(),
      receipts: db.query("SELECT receipt_id FROM canon_receipts ORDER BY receipt_id").all() });
    const original = truth();
    const dismissed = await f.h.runCliAsync(f.env, "attention", "dismiss", cue.cue, "--json");
    expect(dismissed.exitCode, dismissed.stderr).toBe(0);
    const afterDismiss = (await world(owner, { operation: "attention" })).result.data;
    expect(afterDismiss.states.find((row: any) => row.cue === cue.cue)).toEqual({ ...cue, disposition: "dismissed" });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect(await f.call("attention_disposition", { cue: cue.cue, action: "snooze", until }))
      .toEqual({ ...cue, disposition: "snoozed", snoozedUntil: until });
    const app = await f.call("world_view", { operation: "attention", ...WHEN });
    expect(app.result.data.states.find((row: any) => row.cue === cue.cue)).toEqual({ ...cue, disposition: "snoozed", snoozedUntil: until });
    expect((await world(peer, { operation: "attention" })).result.data.states.find((row: any) => row.cue === peerCue.cue)).toEqual(peerCue);
    expect(truth()).toEqual(original);
  } finally { db.close(); }
  expect((await world(owner, { operation: "situation", situation: cue.subject, card: "kizuki.situation-card/v2" })).result.data).toEqual(before);
  expect((await world(owner, { operation: "attention", knownAt: { kind: "time", at: "2026-10-01T00:00:00.000Z" } })).result)
    .toEqual({ status: "unavailable", reason: "history" });
  return { owner: cue.cue, peer: peerCue.cue };
}

export async function attentionErased(client: StdioClient, oldCue: string) {
  const read = (await world(client, { operation: "attention" })).result.data;
  expect(read.schema).toBe("kizuki.attention/v1");
  expect(read.states.some((row: any) => row.state === "candidate")).toBe(false);
  expect(JSON.stringify(read)).not.toContain(oldCue);
}
