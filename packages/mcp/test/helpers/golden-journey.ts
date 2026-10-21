import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listAudit, listCanonReceipts, readSince } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { envelopeOf } from "../client";
import { goldenApp, LABEL, ORIGINAL, REVISED, RICH, WHEN, world } from "./golden-app";
import { assertObservedProcedure, decisionStage, outcomeStage } from "./golden-rich-stages";

/** One disposable vault, actual App capture/writer, and independent MCP clients throughout. */
export async function runGoldenJourney(contract: "kizuki.envelope/v1" | "kizuki.envelope/v2", rich = false) {
  const f = await goldenApp({ rich });
  let hold: ReturnType<typeof f.holdSummaries> | undefined;
  try {
    const { source, initial } = await f.initialize();
    if (rich) await f.operate("run_pass");
    const owner = await f.owner(), peer = await f.peer();
    // Existing owner v1 clients retain their legacy tools; world_view explicitly negotiates v2.
    const context = await owner.call("context_packet", { budget_tokens: 1000, response_contract: contract });
    expect(context.isError ?? false).toBe(false); expect(envelopeOf(context).schema).toBe(contract);
    const discovery = await world(owner, { operation: "find_concepts", label: LABEL });
    expect(discovery.result.data.matches).toHaveLength(1);
    const ref = discovery.result.data.matches[0].ref;
    const first = (await world(owner, { operation: "concept", concept: ref })).result;
    expect(first.status).toBe("current"); expect(first.data.definitions[0].object.value).toBe(ORIGINAL);
    expect(first.view.kind).toBe("view");
    const shared = (await world(owner, { operation: "share", of: { operation: "concept", concept: ref } })).result.data.handle;
    const resumed = (await world(peer, { operation: "resume", handle: shared })).result;
    expect(resumed.status, JSON.stringify(resumed)).toBe("current"); expect(resumed.data.definitions[0].object.value).toBe(ORIGINAL);
    const peerRef = resumed.data.concept.ref;
    const peerBaseline = (await world(peer, { operation: "concept", concept: peerRef })).result;
    expect(peerBaseline.view.kind).toBe("view");
    const evidence = resumed.data.definitions[0].assessments[0].evidence.find((row: any) => row.span.endUtf16 === (rich ? RICH.length : ORIGINAL.length));
    expect(evidence).toBeDefined();
    const expanded = await peer.call("world_view", { operation: "evidence", evidence, response_contract: "kizuki.envelope/v2" });
    expect(expanded.isError ?? false).toBe(false);
    expect(JSON.stringify(expanded)).toContain(ORIGINAL);
    const history = (await world(peer, { operation: "history", concept: peerRef, knownAt: { kind: "time", at: new Date().toISOString() } })).result.data;
    expect(history.snapshot.kind).toBe("snapshot");
    const db = openLedger(join(f.vault, ".kizuki/kizuki.db"));
    try {
      expect(readSince(db, null, 100).events.some(event => event.text === (rich ? RICH : ORIGINAL))).toBe(true);
      expect(listCanonReceipts(db, { limit: 100 }).some(receipt => receipt.writer === "loop")).toBe(true);
      expect(listAudit(db, "owner", { limit: 100 }).some(row => row.tool === "world_view")).toBe(true);
      expect(listAudit(db, "golden-b", { limit: 100 }).some(row => row.tool === "world_view")).toBe(true);
    } finally { db.close(); }
    // Hold an actual consolidation HTTP response after the revised source has reached the writer.
    hold = f.holdSummaries(); writeFileSync(f.file, REVISED);
    await f.operate("capture", { source_key: source, mode: "backfill" });
    const pending = await f.call("run_pass");
    await Promise.race([hold.started, Bun.sleep(10_000).then(() => { throw new Error("consolidation did not start"); })]);
    for (const [client, ownRef, envelope] of [[owner, ref, "kizuki.envelope/v2"], [peer, peerRef, "kizuki.envelope/v2"]] as const) {
      const during = (await world(client, { operation: "concept", concept: ownRef }, envelope)).result;
      expect(JSON.stringify(during)).toContain(REVISED);
      expect(during.status).toBe("incomplete"); expect(during.data.summary).toBeNull();
      expect(during.data.coverage.gaps.some((gap: string) => gap === "pending_consolidation" || gap === "stale_dependencies")).toBe(true);
    }
    hold.release(); hold = undefined; await f.done(pending.operation_id);
    expect((await world(owner, { operation: "concept", concept: ref })).result.status).toBe("current");
    const current = (await world(owner, { operation: "concept", concept: ref })).result.data;
    const correctionTarget = current.definitions.find((row: any) => row.object.value === REVISED);
    expect(correctionTarget).toBeDefined();
    const beforeCorrection = (await world(owner, { operation: "history", concept: ref, knownAt: { kind: "time", at: new Date().toISOString() } })).result.data.snapshot;
    const correctedText = "Equal-priority requests preserve their original sequence.";
    const corrected = await owner.call("correct", { target: { world_claim: correctionTarget.claim }, statement: correctedText, mode: "replace_object", object: { kind: "literal", value: correctedText }, response_contract: contract });
    expect(corrected.isError ?? false, JSON.stringify(corrected)).toBe(false);
    const correction = envelopeOf(corrected).data as any; expect(typeof correction.receipt_id).toBe("string");
    for (const [client, ownRef] of [[owner, ref], [peer, peerRef]] as const) {
      const card = (await world(client, { operation: "concept", concept: ownRef })).result.data;
      expect(card.definitions.some((row: any) => row.object.value === correctedText)).toBe(true);
      expect(card.definitions.some((row: any) => row.object.value === REVISED)).toBe(false);
    }
    const past = (await world(owner, { operation: "concept", concept: ref, knownAt: { kind: "snapshot", ref: beforeCorrection } })).result.data;
    expect(past.definitions.some((row: any) => row.object.value === REVISED)).toBe(true);
    expect(past.definitions.some((row: any) => row.object.value === correctedText)).toBe(false);
    await f.operate("undo", { receipt_id: correction.receipt_id, cascade: false });
    for (const [client, ownRef] of [[owner, ref], [peer, peerRef]] as const)
      expect((await world(client, { operation: "concept", concept: ownRef })).result.data.definitions.some((row: any) => row.object.value === REVISED)).toBe(true);
    if (rich) await decisionStage(f, owner, peer);
    const grantFile = join(f.h.tempDir("golden-grant-"), "grant.json");
    writeFileSync(grantFile, JSON.stringify({ ...f.peerGrant, subjects: [] }));
    const narrowed = await f.h.runCliAsync(f.env, "agent", "grant", "golden-b", "--grant", grantFile, "--operation-id", "golden-narrow", "--json");
    expect(narrowed.exitCode, narrowed.stderr).toBe(0);
    const noResume = (await world(peer, { operation: "resume", handle: shared })).result;
    expect(noResume).toEqual({ status: "new_view_required" });
    for (const input of [{ operation: "concept", concept: peerRef, priorView: peerBaseline.view }, { operation: "concept", concept: peerRef, knownAt: { kind: "snapshot", ref: history.snapshot } }, { operation: "evidence", evidence }]) {
      const response = await peer.call("world_view", { ...WHEN, ...input, response_contract: "kizuki.envelope/v2" });
      const text = JSON.stringify(response); expect(text).not.toContain(ORIGINAL); expect(text).not.toContain(REVISED); expect(text).not.toContain(LABEL);
      expect(response.isError ?? false, `${input.operation}: ${text}`).toBe(false);
      const data = envelopeOf(response).data as any;
      if (input.operation === "evidence") expect(data).toEqual({ status: "not_found" });
      else expect(data.result).toEqual({ status: "new_view_required" });
    }
    expect((await world(owner, { operation: "concept", concept: ref })).result.data.definitions.some((row: any) => row.object.value === REVISED)).toBe(true);
    if (rich) await outcomeStage(f, owner);
    const rebuilt = await f.h.runCliAsync(f.env, "rebuild", "--layer", "world", "--json");
    expect(rebuilt.exitCode, rebuilt.stderr).toBe(0);
    const afterRebuild = (await world(owner, { operation: "find_concepts", label: LABEL })).result.data.matches[0].ref;
    expect((await world(owner, { operation: "concept", concept: afterRebuild })).result.data.definitions.some((row: any) => row.object.value === REVISED)).toBe(true);
    if (rich) await assertObservedProcedure(owner);
    const backup = f.h.tempDir("golden-snapshot-"), restored = join(f.h.tempDir("golden-restored-parent-"), "vault");
    const saved = await f.h.runCliAsync(f.env, "backup", "--out", backup); expect(saved.exitCode, saved.stderr).toBe(0);
    const restoredResult = await f.h.runCliAsync(f.env, "restore", "--from", backup, "--into", restored);
    expect(restoredResult.exitCode, restoredResult.stderr).toBe(0); expect(restoredResult.stdout).toContain("reenroll_agent=golden-b");
    const restoredOwner = await f.owner(restored);
    const restoredRef = (await world(restoredOwner, { operation: "find_concepts", label: LABEL })).result.data.matches[0].ref;
    expect((await world(restoredOwner, { operation: "concept", concept: restoredRef })).result.data.definitions.some((row: any) => row.object.value === REVISED)).toBe(true);
    if (rich) await assertObservedProcedure(restoredOwner);
    expect((await world(restoredOwner, { operation: "resume", handle: shared })).result.status).toBe("new_view_required");
    const sources = await f.call("sources"), revision = sources.sources.find((row: any) => row.source_key === source).revision;
    await f.operate("revoke", { source_key: source, expected_revision: revision, operation_id: "golden-revoke" });
    expect((await world(owner, { operation: "find_concepts", label: LABEL })).result.data.matches).toHaveLength(0);
    if (rich) expect((await world(owner, { operation: "find_procedures", label: "Verify delivery" })).result.data.matches).toHaveLength(0);
    await f.operate("resume_revocation", { source_key: source, operation_id: "golden-revoke" });
    const afterPurge = (await f.call("sources")).sources.find((row: any) => row.source_key === source);
    expect(afterPurge.consent, JSON.stringify(afterPurge)).toBe("purged");
    const erasedDb = openLedger(join(f.vault, ".kizuki/kizuki.db"));
    try {
      expect(erasedDb.query("SELECT count(*) AS n FROM source_event_bindings b JOIN events e ON e.event_id=b.event_id WHERE b.source_key=?").get(source)).toEqual({ n: 0 });
      expect(erasedDb.query("SELECT count(*) AS n FROM claim_v2_support WHERE source_key=?").get(source)).toEqual({ n: 0 });
      expect(erasedDb.query("SELECT count(*) AS n FROM world_consolidation").get()).toEqual({ n: 0 });
    } finally { erasedDb.close(); }
    expect((await world(owner, { operation: "find_concepts", label: LABEL })).result.data.matches).toHaveLength(0);
    expect(initial.run.model_calls).toBeGreaterThan(0); expect(f.counts().summaryCalls).toBeGreaterThan(1);
  } finally { hold?.release(); await f.close(); }
}
