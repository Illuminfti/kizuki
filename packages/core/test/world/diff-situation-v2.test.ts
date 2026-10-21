import { expect, test } from "bun:test";
import { serveWorldView } from "../../src/serving/world-view";
import { situationV2Fixture } from "../helpers/situation-v2-fixture";
import { EMPTY_SUMMARY_MODEL, completeEmptyWorldSummaries } from "../helpers/world-consolidation";

const WHEN = {valid:{kind:"all"},knownAt:{kind:"current"}} as const;
test("Situation v2 diffs preserve the exact card selector and reject invalid optional selectors", async () => {
  const f = await situationV2Fixture(undefined,{model:EMPTY_SUMMARY_MODEL});
  try {
    await completeEmptyWorldSummaries(f.db,f.ctx.vaultPath);
    const of = {operation:"situation",situation:f.findSituation(),card:"kizuki.situation-card/v2"};
    const before = serveWorldView(f.ctx,{...of,...WHEN}).data;
    if (!("result" in before) || before.result.status!=="current" || !("kind" in before.result.view)) throw Error(`complete v2 baseline required ${JSON.stringify(before)}`);
    expect(before.result.data.schema).toBe("kizuki.situation-card/v2");
    const request={operation:"diff",of,priorView:before.result.view,...WHEN};
    expect(serveWorldView(f.ctx,request).data).toMatchObject({result:{status:"unchanged",view:before.result.view}});
    for(const selector of [{card:"kizuki.situation-card/v3"},{unexpected:true},{valid:{kind:"unknown_only"}}]) {
      expect(()=>serveWorldView(f.ctx,{...request,of:{...of,...selector}})).toThrow("invalid arguments: world_view");
    }
    expect(serveWorldView(f.ctx,{...request,of:{operation:"situation",situation:of.situation}}).data).toMatchObject({result:{status:"new_view_required"}});
  } finally {f.dispose();}
},120000);
