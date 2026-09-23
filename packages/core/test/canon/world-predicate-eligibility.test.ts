import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { insertClaim, getClaim } from "../../src/claims/store";
import { applyCanonWrite } from "../../src/canon/apply";
import { worldCanonTarget } from "../../src/canon/world-materialization";
import { parseWorldAdmission } from "../../src/contracts/world-admission";
import { canonFixture, budget } from "./helpers";
import { worldFixture } from "../serving/world-fixture";

for (const variant of ["unknown_predicate", "registered_nonliteral"] as const) {
  test(`typed canon withholds ${variant} while materializing eligible peers`, async () => {
    const f = canonFixture();
    try {
      const world = await worldFixture(f.db);
      const row = f.db.query<{ admission: string }, [string]>(
        "SELECT admission FROM claim_v2_support WHERE claim_id=?",
      ).get(world.claims[2]!)!;
      const basis = parseWorldAdmission(JSON.parse(row.admission))!;
      const semantic = {
        ...basis.semantic,
        predicate: variant === "unknown_predicate" ? "unregistered.invented" : "employment.role",
        object: variant === "unknown_predicate" ? basis.semantic.object : { kind: "subject" as const, ref: basis.semantic.subject },
      };
      const body = "Unregistered typed assertion must stay out of canon.";
      const result = await insertClaim({ db: f.db }, {
        kind: "claim", body, provenance: [world.eventId], producer: "deterministic",
        confidence: 0.8, sensitivity: "public", subjects: [semantic.subject.id], semantic,
        world_admission: { ...basis, semantic, rendering: { body, frontmatter: {} } },
      });
      expect(result.outcome).toBe("stored");
      if (result.outcome !== "stored") throw new Error("typed fixture was not stored");
      const target = worldCanonTarget(f.db, result.claim.claim_id);
      if (target.action !== "create") throw new Error("fresh fixture must create a page");
      expect(() => applyCanonWrite(f.io, result.claim, target, { writer: "loop", budget: budget() }))
        .toThrow("exact admitted world handle");
      expect(existsSync(join(f.vault, target.rel_path))).toBe(false);
      expect(getClaim(f.db, result.claim.claim_id)!.receipt_id).toBeNull();
      const first = getClaim(f.db, world.claims[0]!)!;
      const receipt = applyCanonWrite(f.io, first, worldCanonTarget(f.db, first.claim_id), { writer: "loop", budget: budget() });
      expect(receipt.claim_ids).not.toContain(result.claim.claim_id);
      expect(readFileSync(join(f.vault, receipt.page_path), "utf8")).not.toContain(body);
      expect(getClaim(f.db, result.claim.claim_id)!.receipt_id).toBeNull();
    } finally { f.dispose(); }
  });
}
