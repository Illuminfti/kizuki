import { expect, spyOn, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { OwnedDirectory } from "../../core/src/util/owned-directory";
import { createFts5RetrievalPort, eraseOwnedFts5Generation, FTS5_RETRIEVAL_ID } from "@kizuki/core";
import type { PortContext } from "@kizuki/core";
import { openEmbeddedRetrievalPort, eraseOwnedEmbeddedGeneration, EMBEDDED_RETRIEVAL_ID } from "@kizuki/retrieval-pg";

for (const engine of ["fts", "pg"] as const) for (const mode of ["active", "restart"] as const) for (const replacement of ["root", "intermediate"] as const) {
  test(`${engine} ${mode}: ${replacement} substitution after final check cannot redirect deletion`, async () => {
    const base = mkdtempSync(join(tmpdir(), "native-erasure-race-"));
    const id = engine === "fts" ? FTS5_RETRIEVAL_ID : EMBEDDED_RETRIEVAL_ID;
    const ctx: PortContext = { vault_path: base, data_dir: join(base, ".kizuki/retrieval", id), config: {}, clock: () => new Date().toISOString(), logger: () => {}, secrets: async () => "" };
    const port = engine === "fts" ? createFts5RetrievalPort(ctx) : await openEmbeddedRetrievalPort(ctx);
    if (mode === "restart") await port.close();
    const original = OwnedDirectory.prototype.removeTree;
    let replaced = false;
    const outside = join(base, "outside"), outsideRoot = replacement === "root" ? outside : join(outside, id);
    mkdirSync(join(outsideRoot, "store"), { recursive: true });
    writeFileSync(join(outsideRoot, "store/canary"), "SYNTHETIC_UNRELATED_KEEP");
    const hook = spyOn(OwnedDirectory.prototype, "removeTree").mockImplementation(function(this: OwnedDirectory, ...args: Parameters<OwnedDirectory["removeTree"]>) {
      const assert = this.assertCurrent.bind(this);
      const boundary = spyOn(this, "assertCurrent").mockImplementation(() => {
        assert();
        if (!replaced) {
          replaced = true;
          const old = replacement === "root" ? ctx.data_dir : dirname(ctx.data_dir);
          const moved = join(base, "moved"); renameSync(old, moved);
          // Matching diagnostic tokens must not cause a path-based lease finalizer to remove this unrelated held directory.
          const movedRoot = replacement === "root" ? moved : join(moved, id);
          if (existsSync(join(movedRoot, "lease"))) {
            cpSync(join(movedRoot, "lease"), join(outsideRoot, "lease"), { recursive: true });
            writeFileSync(join(outsideRoot, "lease/held/canary"), "SYNTHETIC_UNRELATED_KEEP");
          }
          symlinkSync(outside, old);
        }
      });
      try { return original.apply(this, args); } finally { boundary.mockRestore(); }
    });
    try {
      const work = mode === "active" ? port.eraseOwnedGeneration() : engine === "fts" ? eraseOwnedFts5Generation(ctx) : eraseOwnedEmbeddedGeneration(ctx);
      await expect(work).rejects.toThrow("identity");
      expect(replaced).toBe(true);
      expect(readFileSync(join(outsideRoot, "store/canary"), "utf8")).toBe("SYNTHETIC_UNRELATED_KEEP");
      if (engine === "pg") expect(readFileSync(join(outsideRoot, "lease/held/canary"), "utf8")).toBe("SYNTHETIC_UNRELATED_KEEP");
    } finally { hook.mockRestore(); await port.close().catch(() => {}); rmSync(base, { recursive: true, force: true }); }
  }, 15_000);
}

for (const engine of ["fts", "pg"] as const) {
  test(`${engine}: preflight identity failure fences queued work and cleanup until process exit`, async () => {
    const base = mkdtempSync(join(tmpdir(), "preflight-erasure-race-"));
    const core = join(import.meta.dir, "../../core/src/index.ts"), pg = join(import.meta.dir, "../../retrieval-pg/src/port.ts");
    const script = join(base, "preflight.ts");
    writeFileSync(script, `import * as fs from 'node:fs'; import {join} from 'node:path'; import {Database} from 'bun:sqlite';
import * as core from ${JSON.stringify(core)}; import {openEmbeddedRetrievalPort} from ${JSON.stringify(pg)};
const base=${JSON.stringify(base)}, engine=${JSON.stringify(engine)}, id=engine==='pg'?'kizuki.retrieval.embedded-pg':'kizuki.retrieval.fts5';
const ctx={vault_path:base,data_dir:join(base,'.kizuki/retrieval',id),config:{},clock:()=>new Date().toISOString(),logger:()=>{},secrets:async()=>''};
const port=engine==='pg'?await openEmbeddedRetrievalPort(ctx):core.createFts5RetrievalPort(ctx);
let release;const wait=new Promise(r=>release=r);let active,queued,called=0,closeCalls=0;
if(engine==='pg') {active=port.store.run(async()=>{await wait});await Promise.resolve();queued=port.health();port.store.close=async()=>{closeCalls++};}
else {queued=port.rebuildFromDocuments((async function*(){await wait;yield {}})());Database.prototype.close=function(){closeCalls++};}
void queued.catch(()=>{});
fs.renameSync(ctx.data_dir,join(base,'moved'));fs.mkdirSync(join(base,'outside/store'),{recursive:true});fs.writeFileSync(join(base,'outside/store/canary'),'KEEP');fs.symlinkSync(join(base,'outside'),ctx.data_dir);
let message='';try{await port.eraseOwnedGeneration()}catch(e){message=e.message}
if(!message.includes('restart_required') || engine==='pg'&&!message.includes('active_sql_uncontained'))process.exit(2);
release();if(active)await active;try{await queued;process.exit(3)}catch{}
try{await port.close();process.exit(4)}catch{}
if(closeCalls!==0)process.exit(5);
if(engine==='pg'){try{await port.store.run(async()=>{called++});process.exit(6)}catch{}if(called!==0)process.exit(7);}
const lock=core.tryAdvisoryFileLock(join(base,'moved',engine==='pg'?'lease/writer.lock':'writer.lock'));if(lock)process.exit(8);
if(fs.readFileSync(join(base,'outside/store/canary'),'utf8')!=='KEEP')process.exit(9);
console.log('pending-process-restart-no-queued-or-cleanup-io');process.exit(0);`);
    try {
      const child = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(child.stdout.toString()).toContain("pending-process-restart-no-queued-or-cleanup-io");
      expect(readFileSync(join(base, "outside/store/canary"), "utf8")).toBe("KEEP");
    } finally { rmSync(base, { recursive: true, force: true }); }
  }, 15_000);
}
