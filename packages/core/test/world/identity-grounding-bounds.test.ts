import { identityCluster } from "../../src/world/identity";
import { newReadFrame, collectReadFrames } from "../../src/world/pipeline/frame";
import { worldNamespace } from "../../src/world/references";
import { handleFor } from "../../src/world/relation";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { OWNER } from "../../src/agents";
import { insertClaim } from "../../src/claims/store";
import type { ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { rawSubjectRefKey } from "../../src/contracts/claim-v2";
import type { WorldGrounding, WorldGroundingPin } from "../../src/contracts/world-admission";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { readWorldView } from "../../src/serving/world-view";
import { sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { enrollSource, worldSeed } from "../helpers/world-seed";
import { tempVault } from "../helpers/vault";

test("actual writer-admitted independent edges respect the component and byte bounds", async () => {
  const vault = tempVault(), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const groundingSource = enrollSource(db, "graph.grounding", "public");
    const witnesses = [enrollSource(db, "graph.witness", "public"), enrollSource(db, "graph.witness", "public")];
    const nodes: WorldGrounding[] = [];
    let anchor: { kind: "object"; token: string } | null = null;
    for (let i = 0; i < 257; i++) {
      const seeded = await worldSeed(db, { sourceKey: groundingSource, connector: "graph.grounding", subject: `c${i}`,
        label: `C${String(i).padStart(4, "0")}`, predicates: [], discover: i === 0 });
      if (i === 0) anchor = seeded.ref;
      const pin = (claim: string): WorldGroundingPin => {
        const row = db.query<{ admission: string; support_key: string }, [string]>("SELECT admission,support_key FROM claim_v2_support WHERE claim_id=?").get(claim)!;
        return { claim_id: claim, support_key: row.support_key, admission_hash: sha256Hex(row.admission), events: db.query<{ event_id: string; event_content_hash: string }, [string]>("SELECT event_id,event_content_hash FROM claim_v2_support_events WHERE support_key=? ORDER BY event_id").all(row.support_key) };
      };
      const classification = pin(seeded.claims[0]!), label = pin(seeded.claims[1]!);
      const subject = JSON.parse(db.query<{ admission: string }, [string]>("SELECT admission FROM claim_v2_support WHERE support_key=?").get(classification.support_key)!.admission).semantic.subject;
      nodes.push({ endpoint: subject, classification, label });
    }
    const connect = async (i: number) => {
      for (const [j, source] of witnesses.entries()) {
        const text = j === 0 ? `C0000 equals C${String(i).padStart(4, "0")}.` : `C${String(i).padStart(4, "0")} aliases C0000.`;
        const accepted = accept(db, { ...validEvent(), connector_id: "graph.witness", source_record_id: ulid(), text, subjects: [], sensitivity_hint: "public" },
          { source: { source_key: source, expected_revision: 1 } });
        if (accepted.status !== "stored") throw new Error("synthetic graph capture failed");
        const semantic: ClaimV2Assertion = { schema: "kizuki.claim/v2", discriminator: "assertion", subject: nodes[0]!.endpoint,
          predicate: "concept.same_as", object: { kind: "subject", ref: nodes[i]!.endpoint },
          perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
          context: [], polarity: "positive", valid_from: null, valid_to: null, temporal_basis: "unknown",
          anchors: [{ event_id: accepted.event.event_id, start_utf16: 0, end_utf16: text.length }] };
        await insertClaim({ db }, { kind: "claim", body: text, provenance: [accepted.event.event_id], producer: "model", confidence: 0.9,
          sensitivity: "public", semantic, world_admission: { schema: "kizuki.world-admission/v2", semantic, rendering: { body: text, frontmatter: {} },
            authority: "model_inference", confidence: 0.9, epistemicKind: "model_inference",
            grounding: [nodes[0]!, nodes[i]!].sort((a, b) => rawSubjectRefKey(a.endpoint) < rawSubjectRefKey(b.endpoint) ? -1 : 1) } });
      }
    };
    for (let i = 1; i < 256; i++) await connect(i);
    const read = () => readWorldView({ db, vaultPath: vault.path, principal: OWNER }, { operation: "concept", concept: anchor, valid: { kind: "all" }, knownAt: { kind: "current" } });
    db.transaction(() => {
      const frame = newReadFrame({ db, vaultPath: vault.path, principal: OWNER }, worldNamespace(db, OWNER), { kind: "all" });
      let component;
      try { component = identityCluster(frame, handleFor(db, nodes[0]!.endpoint)!); } catch (error) { throw new Error(`identity component used ${frame.budget.bytes} bytes`, { cause: error }); }
      expect(component.members).toHaveLength(256);
    }).immediate();
    const completeRead = collectReadFrames(read);
    const complete = completeRead.result;
    // The component fits; its full card independently reaches the existing
    // two-MiB budget and must not expose a partial component as resolved.
    expect("result" in complete && complete.result.status).toBe("unavailable");
    expect(completeRead.frames[0]!.budget.bytes).toBeGreaterThan(2 * 1024 * 1024);
    await connect(256);
    db.transaction(() => {
      const frame = newReadFrame({ db, vaultPath: vault.path, principal: OWNER }, worldNamespace(db, OWNER), { kind: "all" });
      const bounded = identityCluster(frame, handleFor(db, nodes[0]!.endpoint)!);
      expect(bounded.overflow).toBe(true);
      expect(bounded.members).toHaveLength(1);
      expect(bounded.resolution).toBe("ambiguous");
    }).immediate();
    // The full read may hit its stricter byte cap before it can publish the
    // overflow card; it must never return a falsely resolved truncated group.
    const bounded = read();
    expect("result" in bounded && bounded.result.status).toBe("unavailable");
  } finally { db.close(); vault.dispose(); }
}, 180_000);
