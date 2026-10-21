import { applyCanonWrite } from "../../src/canon/apply";
import { worldCanonTarget } from "../../src/canon/world-materialization";
import { getClaim } from "../../src/claims/store";
import { budget } from "../canon/helpers";
import type { Database } from "bun:sqlite";
import type { ServeContext } from "../../src/serving/types";
import type { SituationCardV2 } from "../../src/contracts/situation-card-v2";
import { serveWorldView } from "../../src/serving/world-view";
import { cardFixture } from "../world/card-fixture";
export const SITUATION_V2_WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
export const literal = (value: string) => ({ kind: "literal" as const, value });
export const vocabulary = (id: string) => ({ kind: "vocabulary" as const, ref: { kind: "vocabulary" as const, id } });
export async function situationV2Fixture(database?: Database) {
  const f = await cardFixture(database);
  try {
    const declare = async (subject: string, kind: string, label: string) => {
      await f.write("world.kind", vocabulary(`world/${kind}`), { subject });
      return f.write(`${kind}.label`,literal(label),{subject});
    };
    await declare("project:launch","situation","Launch");
    await declare("commitment:notes","commitment","Prepare notes");
    await declare("commitment:review","commitment","Review draft");
    await declare("decision:format","decision","Use a written brief");
    await f.write("situation.has_commitment",{kind:"subject",ref:f.ref("commitment:notes")},{subject:"project:launch"});
    await f.write("situation.has_commitment",{kind:"subject",ref:f.ref("commitment:review")},{subject:"project:launch"});
    await f.write("situation.has_decision",{kind:"subject",ref:f.ref("decision:format")},{subject:"project:launch"});
    await f.write("commitment.due",literal("2026-10-23"),{subject:"commitment:notes",holder:"person:ada"});
    await f.write("commitment.due",literal("2026-10-22"),{subject:"commitment:notes",holder:"person:ben"});
    const c2 = await f.write("commitment.due",literal("2026-10-24"),{subject:"commitment:review"});
    await f.write("commitment.status",vocabulary("commitment/open"),{subject:"commitment:review"});
    await f.write("decision.status",vocabulary("decision/decided"),{subject:"decision:format"});
    const find = (ctx = f.ctx) => {
      const found = serveWorldView(ctx,{operation:"find_situations",label:"Launch",...SITUATION_V2_WHEN}).data;
      if (!("result" in found) || !("data" in found.result) || !("matches" in found.result.data)) throw new Error("situation not discovered");
      return found.result.data.matches[0]!.ref;
    };
    const input = (ctx = f.ctx, overrides: Record<string,unknown> = {}) => ({operation:"situation",situation:find(ctx),card:"kizuki.situation-card/v2",...SITUATION_V2_WHEN,...overrides});
    const read = (ctx: ServeContext = f.ctx, overrides: Record<string,unknown> = {}): SituationCardV2 => {
      const result = serveWorldView(ctx,input(ctx,overrides)).data;
      if (!("result" in result) || !("data" in result.result) || result.result.data.schema !== "kizuki.situation-card/v2") throw new Error(`situation unavailable: ${JSON.stringify(result)}`);
      return result.result.data;
    };
    const materialize = (subject: string) => {
      const claims = f.db.query<{claim_id:string},[string]>("SELECT c.claim_id FROM claim_v2_semantics c JOIN claims USING(claim_id) WHERE c.subject_id=? AND claims.status='live' AND claims.receipt_id IS NULL").all(subject)
        .map(row => getClaim(f.db,row.claim_id)!).filter(Boolean);
      if (claims.length === 0) throw new Error("no fixture claims to materialize");
      return applyCanonWrite({db:f.db,vault_path:f.ctx.vaultPath},claims,worldCanonTarget(f.db,claims[0]!.claim_id),{writer:"loop",budget:budget()});
    };
    return {...f,declare,materialize,findSituation:find,situationInput:input,readSituation:read,c2};
  } catch (error) { f.dispose(); throw error; }
}
