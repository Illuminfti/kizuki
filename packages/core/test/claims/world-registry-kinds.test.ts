import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER } from "../../src/agents";
import { applyCanonWrite } from "../../src/canon/apply";
import {
  assertWorldCanonPage,
  selectWorldMaterialization,
  worldCanonPath,
  worldClaimHandle,
} from "../../src/canon/world-materialization";
import { isWorldCanonReceipt } from "../../src/canon/world-receipt";
import { getClaim } from "../../src/claims/store";
import { createWorldRegistry, worldPredicate } from "../../src/contracts/world-kinds";
import { WORLD_VOCABULARY_MODULES, withWorldRegistry } from "../../src/contracts/world-vocabulary";
import { readWorldView } from "../../src/serving/world-view";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { budget, canonFixture } from "../canon/helpers";
import { testKind } from "../helpers/world-kinds";
import { worldWriter } from "../helpers/world-writer";

const ghosts = createWorldRegistry([
  ...WORLD_VOCABULARY_MODULES,
  testKind("ghost", { pageType: "person" }, [
    worldPredicate({ predicate: "ghost.trait", subject: "concept", objects: ["literal"], polarity: ["positive"] }),
  ]),
]);

test("a kind registered in one file is enforced by the shared writer", async () => {
  await withWorldRegistry(ghosts, async () => {
    const w = worldWriter();
    try {
      expect((await w.classify("ghost:mira", "world/ghost")).outcome).toBe("stored");
      expect((await w.write({ subject: "ghost:mira", predicate: "ghost.trait", object: { literal: "translucent" } })).outcome).toBe("stored");
      await expect(w.write({ subject: "ghost:mira", predicate: "ghost.trait", object: { literal: "opaque" }, polarity: "negative" }))
        .rejects.toMatchObject({ code: "world_polarity" });
      await w.classify("situation:launch", "world/situation");
      await expect(w.write({ subject: "situation:launch", predicate: "ghost.trait", object: { literal: "translucent" } }))
        .rejects.toMatchObject({ code: "world_endpoint_kind" });
    } finally { w.close(); }
  });
  const w = worldWriter();
  try {
    await expect(w.classify("ghost:mira", "world/ghost")).rejects.toMatchObject({ code: "world_vocabulary_value" });
  } finally { w.close(); }
});

test("a kind registered in one file materializes to a canon page with its declared page type and label", async () => {
  const f = canonFixture();
  try {
    await withWorldRegistry(ghosts, async () => {
      const w = worldWriter({ db: f.db });
      const kind = await w.classify("ghost:mira", "world/ghost");
      const label = await w.write({ subject: "ghost:mira", predicate: "ghost.label", object: { literal: "Mira the ghost" } });
      if (kind.outcome !== "stored" || label.outcome !== "stored") throw new Error("fixture claims not stored");
      const handle = worldClaimHandle(f.db, kind.claim.claim_id)!;
      expect(selectWorldMaterialization(f.db, handle)).toMatchObject({ title: "Mira the ghost", pageType: "person" });
      const path = worldCanonPath(handle);
      const receipt = applyCanonWrite(f.io, [getClaim(f.db, kind.claim.claim_id)!, getClaim(f.db, label.claim.claim_id)!], { action: "create", rel_path: path }, { writer: "loop", budget: budget() });
      if (!isWorldCanonReceipt(receipt)) throw new Error("typed receipt expected");
      const bytes = readFileSync(join(f.vault, path));
      expect(parseFrontmatter(bytes.toString("utf8")).data).toMatchObject({ type: "person", title: "Mira the ghost" });
      assertWorldCanonPage(f.db, receipt, bytes, "after");
    });
  } finally { f.dispose(); }
});

test("the canon materializer names no shipped kind", () => {
  const source = readFileSync(new URL("../../src/canon/world-materialization.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/world\/(concept|situation)|(concept|situation)\.label/);
});

test("claims stored before enforcement stay served, and the read side never throws", async () => {
  const loose = createWorldRegistry(WORLD_VOCABULARY_MODULES.map(module =>
    module.kind?.id === "concept"
      ? { ...module, predicates: module.predicates.map(row => row.predicate === "concept.requires"
        ? worldPredicate({ predicate: "concept.requires", subject: "concept", objects: ["concept", "literal"] }) : row) }
      : module));
  const w = worldWriter();
  try {
    await withWorldRegistry(loose, async () => {
      await w.classify("concept:bayes", "world/concept");
      await w.write({ subject: "concept:bayes", predicate: "concept.label", object: { literal: "Bayesian updating" } });
      await w.write({ subject: "concept:bayes", predicate: "concept.definition", object: { literal: "Revise beliefs using evidence" } });
      // Stored while the row still allowed it: a literal object on a requirement edge.
      expect((await w.write({ subject: "concept:bayes", predicate: "concept.requires", object: { literal: "a prior" } })).outcome).toBe("stored");
    });
    // New evidence for the same malformed claim is refused; the stored claim is untouched.
    const stored = w.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!.n;
    await expect(w.write({ subject: "concept:bayes", predicate: "concept.requires", object: { literal: "a prior" } }))
      .rejects.toMatchObject({ code: "world_object_kind" });
    expect(w.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!.n).toBe(stored);
    const ctx = { db: w.db, vaultPath: "/synthetic/vault", principal: OWNER };
    const found = readWorldView(ctx, { operation: "find_concepts", label: "Bayes", valid: { kind: "all" }, knownAt: { kind: "current" } });
    if ("status" in found || found.result.status === "unavailable" || !("matches" in found.result.data)) throw new Error("discovery unavailable");
    expect(found.result.data.matches).toHaveLength(1);
    const card = readWorldView(ctx, { operation: "concept", concept: found.result.data.matches[0]!.ref, valid: { kind: "all" }, knownAt: { kind: "current" } });
    expect(JSON.stringify(card)).toContain("Revise beliefs using evidence");
  } finally { w.close(); }
});
