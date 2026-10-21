import { expect, test } from "bun:test";
import { serveWorldView } from "@kizuki/core/world";
import { situationV2Fixture } from "../../core/test/helpers/situation-v2-fixture";
import { EMPTY_SUMMARY_MODEL, completeEmptyWorldSummaries } from "../../core/test/helpers/world-consolidation";
import { startLoopback } from "../../core/test/helpers/world-kit/loopback";
import { stdioClient } from "../../mcp/test/helpers/two-clients";
import { envelopeOf } from "../../mcp/test/client";
import { createAppHost } from "../src/app/host";
import { createHelpers } from "./helpers";

test("Situation v2 DIFF selector agrees through actual CLI, MCP, HTTP and App", async () => {
  const f=await situationV2Fixture(undefined,{model:EMPTY_SUMMARY_MODEL}), h=createHelpers(), env=h.isolatedEnv();
  let http:Awaited<ReturnType<typeof startLoopback>>|undefined, mcp:Awaited<ReturnType<typeof stdioClient>>|undefined;
  const host=createAppHost({env,vaultOverride:f.ctx.vaultPath,stdinIsTTY:false,stdoutIsTTY:false,stderrIsTTY:false,out:()=>{},err:()=>{},prompt:async()=>""});
  try {
    const init=h.runCli(env,"init",f.ctx.vaultPath,"--no-service","--no-default"); expect(init.exitCode,init.stderr).toBe(0);
    await completeEmptyWorldSummaries(f.db,f.ctx.vaultPath);
    const of={operation:"situation",situation:f.findSituation(),card:"kizuki.situation-card/v2"}, when={valid:{kind:"all"},knownAt:{kind:"current"}};
    const before=serveWorldView(f.ctx,{...of,...when}).data;
    if (!("result" in before)||before.result.status!=="current"||!("kind" in before.result.view)) throw Error("complete baseline required");
    const input={operation:"diff",of,priorView:before.result.view,...when}, expected=serveWorldView(f.ctx,input).data;
    expect(expected).toMatchObject({result:{status:"unchanged"}});
    mcp=await stdioClient(f.ctx.vaultPath,["--owner"],{});
    expect(envelopeOf(await mcp.call("world_view",input)).data).toEqual(expected);
    http=await startLoopback(f.db,f.ctx.vaultPath); const reply=await http.post("world_view",input);
    expect(reply.status).toBe(200); expect((reply.body as any).value.data).toEqual(expected);
    const app:any=await(await host.handle(new Request("http://127.0.0.1/app/v1/world_view",{method:"POST",body:JSON.stringify(input)}))).json();
    expect(app.ok).toBe(true);expect(app.data).toEqual(expected);
    const args=["--vault",f.ctx.vaultPath,"world","--operation=diff","--of-operation=situation",`--ref=${of.situation.token}`,"--card=kizuki.situation-card/v2",`--prior-view=${before.result.view.token}`];
    const json=h.runCli(env,...args,"--json");expect(json.exitCode,json.stderr).toBe(0);expect(JSON.parse(json.stdout).data.data).toEqual(expected);
    const text=h.runCli(env,...args);expect(text.exitCode,text.stderr).toBe(0);expect(text.stdout).toContain("Unchanged since the prior view.");
  } finally {await http?.stop();await mcp?.close();await host.close();f.dispose();h.cleanup();}
},120000);
