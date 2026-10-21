import { expect, test } from "bun:test";
import { serveWorldView } from "../../src/serving/world-view";
import { validateSituationCard } from "../../src/contracts/situation-card";
import { validateSituationCardV2 } from "../../src/contracts/situation-card-v2";
import { cardFixture } from "./card-fixture";

const WHEN={valid:{kind:"all"},knownAt:{kind:"current"}} as const;
for(const [name,value] of [["trailing whitespace","Optional detail ".repeat(20)],["multibyte prose","界".repeat(200)],["maximum length","a".repeat(400)]] as const) {
  test(`accepted ${name} literals render intact in both Situation cards without loosening references`,async()=>{
    const f=await cardFixture();
    try {
      const subject="project:literal-rendering";
      await f.write("world.kind",{kind:"vocabulary",ref:{kind:"vocabulary",id:"world/situation"}},{subject});
      await f.write("situation.label",{kind:"literal",value:"Literal rendering"},{subject});
      await f.write("situation.change",{kind:"literal",value},{subject});
      const found=serveWorldView(f.ctx,{operation:"find_situations",label:"Literal rendering",...WHEN}).data;
      if (!("result" in found)||!("data" in found.result)||!("matches" in found.result.data)) throw Error("situation absent");
      const ref=found.result.data.matches[0]!.ref;
      for(const card of [undefined,"kizuki.situation-card/v2"]) {
        const read=serveWorldView(f.ctx,{operation:"situation",situation:ref,...(card?{card}:{}),...WHEN}).data;
        if (!("result" in read)||!("data" in read.result)||!("recentChange" in read.result.data)) throw Error("card absent");
        expect(read.result.data.recentChange?.object).toEqual({kind:"literal",value});
        const codec=card?validateSituationCardV2:validateSituationCard;
        const invalid={...read.result.data,recentChange:{...read.result.data.recentChange!,subject:{...read.result.data.recentChange!.subject,token:" "+read.result.data.recentChange!.subject.token}}};
        expect(codec(invalid).ok).toBe(false);
        const oversized={...read.result.data,recentChange:{...read.result.data.recentChange!,object:{kind:"literal",value:"a".repeat(401)}}};
        expect(codec(oversized).ok).toBe(false);
      }
    } finally {f.dispose();}
  },120000);
}
