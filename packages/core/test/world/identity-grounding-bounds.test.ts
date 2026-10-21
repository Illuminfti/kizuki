import { identityCluster } from "../../src/world/identity";
import { newReadFrame, collectReadFrames, WORLD_CLAIM_VERIFICATION_LIMIT } from "../../src/world/pipeline/frame";
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

test.each([
  { boundary: "component and shared claim", members: 257, witnessBytes: 0 },
  { boundary: "byte", members: 2, witnessBytes: 1024 * 1024 },
])("actual writer-admitted independent edges respect the $boundary bounds", async ({ members, witnessBytes }) => {
  const vault = tempVault(), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const groundingSource = enrollSource(db, "graph.grounding", "public");
    const witnesses = [enrollSource(db, "graph.witness", "public"), enrollSource(db, "graph.witness", "public")];
    const nodes: WorldGrounding[] = [];
    let anchor: { kind: "object"; token: string } | null = null;
    for (let i = 0; i < members; i++) {
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
        const statement = j === 0 ? `C0000 equals C${String(i).padStart(4, "0")}.` : `C${String(i).padStart(4, "0")} aliases C0000.`;
        const text = statement.padEnd(witnessBytes, j === 0 ? "a" : "b");
        const accepted = accept(db, { ...validEvent(), connector_id: "graph.witness", source_record_id: ulid(), text, subjects: [], sensitivity_hint: "public" },
          { source: { source_key: source, expected_revision: 1 } });
        if (accepted.status !== "stored") throw new Error("synthetic graph capture failed");
        const semantic: ClaimV2Assertion = { schema: "kizuki.claim/v2", discriminator: "assertion", subject: nodes[0]!.endpoint,
          predicate: "concept.same_as", object: { kind: "subject", ref: nodes[i]!.endpoint },
          perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
          context: [], polarity: "positive", valid_from: null, valid_to: null, temporal_basis: "unknown",
          anchors: [{ event_id: accepted.event.event_id, start_utf16: 0, end_utf16: statement.length }] };
        await insertClaim({ db }, { kind: "claim", body: statement, provenance: [accepted.event.event_id], producer: "model", confidence: 0.9,
          sensitivity: "public", semantic, world_admission: { schema: "kizuki.world-admission/v2", semantic, rendering: { body: statement, frontmatter: {} },
            authority: "model_inference", confidence: 0.9, epistemicKind: "model_inference",
            grounding: [nodes[0]!, nodes[i]!].sort((a, b) => rawSubjectRefKey(a.endpoint) < rawSubjectRefKey(b.endpoint) ? -1 : 1) } });
      }
    };
    const read = () => readWorldView({ db, vaultPath: vault.path, principal: OWNER }, { operation: "concept", concept: anchor, valid: { kind: "all" }, knownAt: { kind: "current" } });
    if (witnessBytes > 0) {
      // Only two grounded members and two independent, source-backed edges.
      // Large valid captures reach the byte cap before claim work is exhausted.
      await connect(1);
      const observed = collectReadFrames(read);
      expect(observed.result).toMatchObject({ result: { status: "unavailable", reason: "budget" } });
      expect(observed.frames.length).toBeGreaterThan(0);
      const budget = observed.frames[0]!.budget;
      expect(budget.bytes).toBeGreaterThan(2 * 1024 * 1024);
      expect(budget.claimVerifications).toBeGreaterThan(0);
      expect(budget.claimVerifications).toBeLessThan(WORLD_CLAIM_VERIFICATION_LIMIT);
      return;
    }
    for (let i = 1; i < 256; i++) await connect(i);
    db.transaction(() => {
      const frame = newReadFrame({ db, vaultPath: vault.path, principal: OWNER }, worldNamespace(db, OWNER), { kind: "all" });
      let component;
      try { component = identityCluster(frame, handleFor(db, nodes[0]!.endpoint)!); } catch (error) { throw new Error(`identity component used ${frame.budget.bytes} bytes`, { cause: error }); }
      expect(component.members).toHaveLength(256);
    }).immediate();
    const completeRead = collectReadFrames(read);
    const complete = completeRead.result;
    // The byte-only internal component fits. A public card shares the claim
    // work allowance and must refuse before publishing a partial identity.
    expect(complete).toMatchObject({ result: { status: "unavailable", reason: "budget" } });
    expect(completeRead.frames[0]!.budget.claimVerifications).toBe(WORLD_CLAIM_VERIFICATION_LIMIT);
    expect(completeRead.frames[0]!.budget.bytes).toBeGreaterThan(0);
    expect(completeRead.frames[0]!.budget.bytes).toBeLessThan(2 * 1024 * 1024);
    await connect(256);
    db.transaction(() => {
      const frame = newReadFrame({ db, vaultPath: vault.path, principal: OWNER }, worldNamespace(db, OWNER), { kind: "all" });
      const bounded = identityCluster(frame, handleFor(db, nodes[0]!.endpoint)!);
      expect(bounded.overflow).toBe(true);
      expect(bounded.members).toHaveLength(1);
      expect(bounded.resolution).toBe("ambiguous");
    }).immediate();
    // Public claim/byte caps also apply to the oversized component; it must
    // never return a falsely resolved truncated group.
    const bounded = read();
    expect("result" in bounded && bounded.result.status).toBe("unavailable");
  } finally { db.close(); vault.dispose(); }
}, 180_000);
