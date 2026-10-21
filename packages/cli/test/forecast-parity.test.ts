import { expect, test } from "bun:test";
import { serveWorldView } from "@kizuki/core/world";
import { forecastJob } from "../../core/src/world/forecast/job";
import { situationV2Fixture } from "../../core/test/helpers/situation-v2-fixture";
import { startLoopback } from "../../core/test/helpers/world-kit/loopback";
import { twoClients } from "../../mcp/test/helpers/two-clients";
import { envelopeOf } from "../../mcp/test/client";
import { createAppHost } from "../src/app/host";
import { createHelpers } from "./helpers";

test("frozen forecasts and score abstention agree across Core, MCP, HTTP, CLI and App", async () => {
  const clients=await twoClients({seed:{subject:"topic:initial",label:"Initial"},agent:{subjects:null}});
  const f=await situationV2Fixture(clients.db),h=createHelpers(),env=h.isolatedEnv();
  const ctx={...f.ctx,vaultPath:clients.vaultPath};
  const host=createAppHost({env,vaultOverride:clients.vaultPath,stdinIsTTY:false,stdoutIsTTY:false,stderrIsTTY:false,out:()=>{},err:()=>{},prompt:async()=>""});
  let http:Awaited<ReturnType<typeof startLoopback>>|undefined;
  try{
    expect(h.runCli(env,"init",clients.vaultPath,"--no-service","--no-default").exitCode).toBe(0);
    await forecastJob.run({db:f.db,vaultPath:clients.vaultPath,now:()=>new Date().toISOString(),stopRequested:()=>false,modelConfigured:false});
    const commitment=f.readSituation(ctx).commitments.find(c=>c.due.some(d=>d.object.kind==="literal"&&d.object.value==="2026-10-24"))!.commitment;
    http=await startLoopback(clients.db,clients.vaultPath);
    for(const operation of ["forecast","forecast_scores"] as const){
      const input={operation,...(operation==="forecast"?{commitment}:{}),valid:{kind:"all"},knownAt:{kind:"current"}};
      const core=serveWorldView(ctx,input);
      const mcp=await clients.owner.call("world_view",input);expect(mcp.isError??false).toBe(false);expect(envelopeOf(mcp).data).toEqual(core.data);
      const app=await(await host.handle(new Request("http://127.0.0.1/app/v1/world_view",{method:"POST",body:JSON.stringify(input)}))).json() as any;
      expect(app.ok).toBe(true);expect(app.data).toEqual(core.data);
      const response=await http.post("world_view",input);expect(response.status).toBe(200);expect((response.body as any).value.data).toEqual(core.data);
      const args=["--vault",clients.vaultPath,"world","--operation",operation,...(operation==="forecast"?["--ref",commitment.token]:[])];
      const json=h.runCli(env,...args,"--json");expect(json.exitCode,json.stderr).toBe(0);expect(JSON.parse(json.stdout).data.data).toEqual(core.data);
      if(operation==="forecast"){
        const text=h.runCli(env,...args);expect(text.exitCode,text.stderr).toBe(0);expect(text.stdout).toContain("Uncalibrated, no model, no execution authority");expect(text.stdout).toContain("does not establish statistical sufficiency");
      }
    }
  }finally{await http?.stop();await host.close();f.dispose();await clients.close();h.cleanup();}
},120_000);
