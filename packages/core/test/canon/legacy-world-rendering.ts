import { spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import * as materialization from "../../src/canon/world-materialization";
import { parseWorldAdmission } from "../../src/contracts/world-admission";

/** Reproduce pre-semantic rendering through the real authorized writer/validators. */
export function legacyWorldRendering(db: Database) {
  const select = materialization.selectWorldMaterialization;
  return spyOn(materialization, "selectWorldMaterialization").mockImplementation((...args) => {
    const selected = select(...args);
    if (selected === null) return null;
    return { ...selected, basis: selected.basis.map(({ rendering: _rendering, ...item }) => item),
      claims: selected.claims.map((claim, index) => {
        const support = selected.basis[index]!.supports[0]!;
        const row = db.query<{ admission: string }, [string]>("SELECT admission FROM claim_v2_support WHERE support_key=?").get(support.support_key)!;
        return { ...claim, body: parseWorldAdmission(JSON.parse(row.admission))!.rendering.body };
      }) };
  });
}
