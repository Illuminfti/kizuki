import { expect, test } from "bun:test";
import { serveWorldView } from "../../src/serving/world-view";
import { validateWorldSlice } from "../../src/contracts/world-slice";
import { validateAtlas } from "../../src/contracts/atlas";
import { collectReadFrames, WorldClaimBudgetError, type ReadBudget } from "../../src/world/pipeline/frame";
import { beginWorldClaimProjection, eligibleWorldClaim } from "../../src/world/pipeline/eligible";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { verificationScene } from "../helpers/world-verification";
import { hiddenScene } from "../helpers/noninterference";
import { worldSeed } from "../helpers/world-seed";

test("one request shares its candidate limit across discovery, cards and composed reads", async () => {
  const scene = await verificationScene();
  try {
    const when = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
    const normal = collectReadFrames(() => serveWorldView(scene.reader, { operation: "atlas", panel: "home", ...when }));
    expect(normal.frames.length).toBeGreaterThan(1);
    expect(normal.frames.reduce((n, frame) => n + frame.stats.claimsVerified, 0)).toBeLessThanOrEqual(129);
    if (!("result" in normal.result.data) || !("data" in normal.result.data.result)) throw Error("normal Atlas must remain available");
    expect(validateAtlas(normal.result.data.result.data)).toMatchObject({ ok: true });
    // A reused proof must still belong to every child's publication closure.
    expect(normal.frames.filter(frame => frame.stats.claimsVerified === 0 && (frame.dependencies?.claims.size ?? 0) > 0).length).toBeGreaterThan(0);
    await worldSeed(scene.db, {
      sourceKey: scene.visible.concept.sourceKey, subject: "topic:bayes", label: "Bayesian updating", discover: false,
      predicates: Array.from({ length: 160 }, (_, i) => ({ predicate: "concept.example", object: { kind: "literal" as const, value: `Bounded example ${i}.` } })),
    });
    const input = { operation: "slice", task: "Resume the launch", kinds: ["concept", "situation"], budgetTokens: 2000, ...when };
    // Each new public request has its own budget; returned units remain whole.
    for (let attempt = 0; attempt < 2; attempt++) {
      const observed = collectReadFrames(() => serveWorldView(scene.reader, input));
      expect(observed.frames.reduce((n, frame) => n + frame.stats.claimsVerified, 0)).toBeLessThanOrEqual(129);
      expect(observed.result.data).toMatchObject({ result: { status: "incomplete", data: { complete: false, truncated: true } } });
      expect(observed.result.data).not.toHaveProperty("result.view");
      const data = (observed.result.data as any).result.data;
      expect(validateWorldSlice(data)).toMatchObject({ ok: true });
      expect(data.coverage.gaps).toContain("traversal_limit");
      expect(data.providers.map((provider: any) => provider.kind)).toEqual(["concept", "situation"]);
    }
    // Atlas opens multiple child frames. Starting a new frame cannot reset the request budget.
    const composed = collectReadFrames(() => serveWorldView(scene.reader, { operation: "atlas", panel: "stale", ...when }));
    expect(composed.frames.length).toBeGreaterThan(1);
    expect(composed.frames.reduce((n, frame) => n + frame.stats.claimsVerified, 0)).toBeLessThanOrEqual(129);
    expect(composed.result.data).toMatchObject({ result: { status: "unavailable", reason: "budget" } });
    expect(composed.result.quoted).toEqual([]);
    expect(composed.result.canon).toEqual([]);
  } finally { scene.dispose(); }
}, 120_000);

test("reused proofs cannot cross authority, selection, time, support restrictions or projection snapshots", async () => {
  const scene = await hiddenScene();
  try {
    const budget: ReadBudget = { bytes: 0 }, claim = scene.visible.concept.claims[0]!;
    const valid = { kind: "all" } as const;
    scene.db.transaction(() => {
      beginWorldClaimProjection(budget);
      expect(eligibleWorldClaim(scene.reader, claim, valid, budget)).not.toBeNull();
      expect(eligibleWorldClaim(scene.reader, claim, valid, budget)).not.toBeNull();
      expect(budget.claimVerifications).toBe(1);
      expect(eligibleWorldClaim(scene.reader, claim, valid, budget, { supportKeys: [] })).toBeNull();
      expect(eligibleWorldClaim(scene.reader, claim, { kind: "unknown_only" }, budget)).toBeNull();
      expect(eligibleWorldClaim({ ...scene.reader, selection: { source: { sourceKey: "unselected-source", captureEventId: null } } }, claim, valid, budget)).toBeNull();
      expect(eligibleWorldClaim({ ...scene.reader, principal: { ...scene.reader.principal, grant: { ...scene.reader.principal.grant, subjects: [] } } }, claim, valid, budget)).toBeNull();
      expect(eligibleWorldClaim({ ...scene.reader, sourcePurpose: "session" }, claim, valid, budget)).toBeNull();
      expect(budget.claimVerifications).toBe(6);
      expect(eligibleWorldClaim(scene.reader, claim, valid, budget)).not.toBeNull();
      expect(budget.claimVerifications).toBe(6);
    }).immediate();
    revokeSourceGrant(scene.db, { source_key: scene.visible.concept.sourceKey, expected_revision: 1, operation_id: "budget-proof-revoke" });
    scene.db.transaction(() => {
      beginWorldClaimProjection(budget);
      expect(eligibleWorldClaim(scene.reader, claim, valid, budget)).toBeNull();
      expect(budget.claimVerifications).toBe(7);
      budget.claimVerifications = 129;
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => eligibleWorldClaim(scene.reader, "unexamined-claim", valid, budget)).toThrow(WorldClaimBudgetError);
        expect(budget.claimVerifications).toBe(129);
      }
    }).immediate();
  } finally { scene.dispose(); }
}, 120_000);
