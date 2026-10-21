import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonFixture, budget } from "./helpers";
import { worldFixture } from "../serving/world-fixture";
import { getClaim } from "../../src/claims/store";
import { applyCanonWrite } from "../../src/canon/apply";
import { assertWorldCanonPage, worldCanonPath, worldClaimHandle } from "../../src/canon/world-materialization";
import { isWorldCanonReceipt } from "../../src/canon/world-receipt";
import { getCanonReceipt } from "../../src/canon/receipts";
import { correct } from "../../src/correction/correct";
import { undoReceipt } from "../../src/canon/undo";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { initGraph } from "../../src/graph";
import { initSearch } from "../../src/search";
import { renderWorldAssertion } from "../../src/canon/world-rendering";
import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import { tempVault } from "../helpers/vault";
import { legacyWorldRendering } from "./legacy-world-rendering";
import { runPurge } from "../../src/ledger/purge";
import { recoverCanonWrites } from "../../src/canon/recovery";
import { readCanonWriteIntent } from "../../src/canon/write-intent";

const SOURCE = "Bayesian updating means revising beliefs using evidence.";
const CORRECTED = "Use prior odds and the likelihood ratio.";

test("legacy source prose transitions to semantic canon on correction, restores, and undoes exactly", async () => {
  const f = canonFixture();
  const transfer = tempVault("kizuki-semantic-transfer-");
  const historical = legacyWorldRendering(f.db);
  try {
    initSearch(f.db); initGraph(f.db);
    const world = await worldFixture(f.db, { renderingBody: SOURCE });
    const claims = world.claims.map(id => getClaim(f.db, id)!);
    const path = worldCanonPath(worldClaimHandle(f.db, claims[0]!.claim_id)!);
    const original = applyCanonWrite(f.io, claims, { action: "create", rel_path: path }, { writer: "loop", budget: budget() });
    if (!isWorldCanonReceipt(original)) throw Error("typed receipt required");
    historical.mockRestore();
    expect(original.basis.after!.every(item => item.rendering === undefined)).toBe(true);
    const legacyBytes = readFileSync(join(f.vault, path));
    expect(legacyBytes.toString().split(SOURCE)).toHaveLength(4);
    assertWorldCanonPage(f.db, original, legacyBytes, "after");
    const evidence = f.db.query("SELECT support_key,admission FROM claim_v2_support ORDER BY support_key").all();

    const correction = await correct(f.io, { statement: CORRECTED, target: { claim_id: world.claims[2]! } });
    const receipt = getCanonReceipt(f.db, correction.receipt_id!)!;
    if (!isWorldCanonReceipt(receipt)) throw Error("typed correction required");
    expect(receipt.basis.before!.every(item => item.rendering === undefined)).toBe(true);
    expect(receipt.basis.after!.every(item => item.rendering === "semantic/v1")).toBe(true);
    const changed = readFileSync(join(f.vault, path));
    expect(changed.toString()).toContain(CORRECTED);
    expect(changed.toString()).not.toContain(SOURCE);
    expect(changed.toString()).not.toContain("Revise beliefs using evidence");
    assertWorldCanonPage(f.db, receipt, changed, "after");
    for (const row of evidence) expect(f.db.query("SELECT support_key,admission FROM claim_v2_support WHERE support_key=?").get((row as {support_key: string}).support_key)).toEqual(row);
    expect(f.db.query<{text: string}, [string]>("SELECT text FROM events WHERE event_id=?").get(world.eventId)!.text).toBe(SOURCE);

    const backup = join(transfer.path, "backup"), restored = join(transfer.path, "restored");
    exportVault(f.db, f.vault, backup); restoreVault(backup, restored);
    const copy = openLedger(join(restored, ".kizuki/kizuki.db"));
    try {
      expect(readFileSync(join(restored, path))).toEqual(changed);
      const undone = await undoReceipt({ db: copy, vault_path: restored }, receipt.receipt_id);
      if (!isWorldCanonReceipt(undone)) throw Error("typed undo required");
      expect(readFileSync(join(restored, path))).toEqual(legacyBytes);
      assertWorldCanonPage(copy, undone, legacyBytes, "after");
    } finally { copy.close(); }
  } finally { historical.mockRestore(); f.dispose(); transfer.dispose(); }
});

test("semantic rendering preserves assertion qualifiers without exposing raw references", async () => {
  const f = canonFixture();
  try {
    const world = await worldFixture(f.db);
    const semantic = readClaimV2Semantic(f.db, world.claims[2]!)!;
    if (semantic.discriminator !== "assertion") throw Error("assertion required");
    const another={...semantic.subject,id:"synthetic-context-peer"};
    const text = renderWorldAssertion({ ...semantic, schema:"kizuki.claim/v2", anchors: [], polarity: "negative", context: [semantic.subject,another],
      perspective: { ...semantic.perspective, anchors: [], holder: semantic.subject, speaker:another, addressee:semantic.subject, mode: "quoted", interpretation: "inferred" },
      valid_to: "2026-12-31T00:00:00Z" });
    for (const qualifier of ["negative", "quoted", "inferred interpretation", "holder: record", "speaker: record", "addressee: record", "context:", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00Z", "explicit time basis"]) expect(text).toContain(qualifier);
    expect(text.match(/context: record [a-f0-9]{64}, record [a-f0-9]{64}/)).not.toBeNull();
    expect(text).not.toContain(semantic.subject.id); expect(text).not.toContain(world.sourceKey);
    expect(text).not.toContain(another.id);
  } finally { f.dispose(); }
});


test("an interrupted legacy erasure recovers its exact recorded rendering after upgrade", async () => {
  const f = canonFixture(), historical = legacyWorldRendering(f.db);
  try {
    initSearch(f.db); initGraph(f.db);
    const world = await worldFixture(f.db, { renderingBody: SOURCE });
    const claims = world.claims.map(id => getClaim(f.db, id)!);
    const path = worldCanonPath(worldClaimHandle(f.db, claims[0]!.claim_id)!);
    applyCanonWrite(f.io, claims, { action: "create", rel_path: path }, { writer: "loop", budget: budget() });
    await correct(f.io, { statement: CORRECTED, target: { claim_id: world.claims[2]! } });
    f.db.exec("CREATE TRIGGER stop_legacy_erasure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(ABORT,'synthetic legacy interruption'); END");
    await expect(runPurge(f.db, f.vault, {event_id: world.eventId}, "synthetic upgrade erasure")).rejects.toThrow("synthetic legacy interruption");
    const pending = readCanonWriteIntent(f.db)!;
    expect(pending.version).toBe(3);
    if (!isWorldCanonReceipt(pending.receipt)) throw Error("typed erasure required");
    expect(pending.receipt.basis.after!.every(item => item.rendering === undefined)).toBe(true);
    const before = readFileSync(join(f.vault, path));
    historical.mockRestore();
    f.db.exec("DROP TRIGGER stop_legacy_erasure");
    expect(recoverCanonWrites(f.io).completed).toEqual([pending.receipt.receipt_id]);
    expect(readFileSync(join(f.vault, path))).toEqual(before);
    expect(before.toString()).toContain(CORRECTED);
    expect(before.toString()).not.toContain(SOURCE);
    expect(recoverCanonWrites(f.io).completed).toEqual([]);
  } finally { historical.mockRestore(); f.dispose(); }
});
