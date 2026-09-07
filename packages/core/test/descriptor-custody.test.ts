import { expect, test } from "bun:test";
import { join } from "node:path";

for (const inherited of ["data", "getter"] as const) {
  for (const scope of ["ingress", "audit", "truncated-audit"] as const) {
    test(`${scope} ignores an inherited descriptor ${inherited} property`, () => {
      const script = `
        import { strict as assert } from "node:assert";
        import { snapshotDataRecord, snapshotDataArray } from ${JSON.stringify(join(import.meta.dir, "../src/util/validate.ts"))};
        import { validateEventInput } from ${JSON.stringify(join(import.meta.dir, "../src/contracts/event.ts"))};
        import { validEvent } from ${JSON.stringify(join(import.meta.dir, "fixtures.ts"))};
        import { shapeArguments, listAudit } from ${JSON.stringify(join(import.meta.dir, "../src/agents/audit.ts"))};
        import { accept } from ${JSON.stringify(join(import.meta.dir, "../src/ledger/ledger.ts"))};
        import { gate } from ${JSON.stringify(join(import.meta.dir, "../src/serving/gate.ts"))};
        import { serveFixture } from ${JSON.stringify(join(import.meta.dir, "serving/helpers.ts"))};
        const f=await serveFixture(), ctx=f.agent("search-only");
        try {
          assert.equal(Object.hasOwn(Object.prototype,"value"),false);
          let originalGets=0, inheritedGets=0, callback=0;
          const accessor={enumerable:true,get(){originalGets++;throw new Error("input getter must not run");}};
          const record={}; Object.defineProperty(record,"trap",accessor);
          const array=[]; Object.defineProperty(array,"0",accessor);
          const args={record,array}; Object.defineProperty(args,"top",accessor);
          const scope=${JSON.stringify(scope)};
          if(scope==="truncated-audit")for(let i=0;i<40;i++)args["extra"+i]=i;
          const event=validEvent(); event.source_record_id="poisoned-descriptor";
          Object.defineProperty(event,"text",accessor);
          const before=listAudit(f.db,"search-only").length;
          const poison=Object.create(null); poison.configurable=true;
          if(${JSON.stringify(inherited)}==="data")poison.value="poisoned synthetic input";
          else poison.get=()=>{inheritedGets++;return "poisoned synthetic input";};
          let result, failure;
          Object.defineProperty(Object.prototype,"value",poison);
          try {
            if(scope==="ingress") {
              const errors=[];
              result={record:snapshotDataRecord(record,"record",errors,5),array:snapshotDataArray(array,"array",5,errors),
                errors,validation:validateEventInput(event),accepted:accept(f.db,event)};
            } else {
              const shaped=shapeArguments(args);
              let denial;
              try { gate(ctx,"propose",args,()=>{callback++;return {canon:[],quoted:[],withheld:[]};}); }
              catch(error){denial=error;}
              result={shaped,denial};
            }
          } catch(error){failure=error;}
          finally {delete Object.prototype.value;}
          assert.equal(failure,undefined);
          assert.equal(originalGets,0); assert.equal(inheritedGets,0);
          if(scope==="ingress") {
            assert.equal(result.record,undefined); assert.equal(result.array,undefined);
            assert.equal(result.errors.length,2); assert.equal(result.validation.ok,false);
            assert.equal(result.accepted.status,"error"); assert.equal(result.accepted.kind,"validation");
            assert.equal(f.db.query("SELECT count(*) n FROM events WHERE source_record_id=?").get(event.source_record_id).n,0);
          } else {
            assert.equal(result.denial?.code,"tool_not_granted"); assert.equal(callback,0);
            const rows=listAudit(f.db,"search-only"); assert.equal(rows.length,before+1);
            assert.deepEqual(rows[0].denied,[{id:"tool:propose",reason:"tool_not_granted"}]);
            for(const shape of [result.shaped,rows[0].query_shape]) {
              assert.deepEqual(shape.top,{type:"accessor"});
              assert.deepEqual(shape.record.trap,{type:"accessor"});
              assert.deepEqual(shape.array[0],{type:"accessor"});
            }
            if(scope==="truncated-audit")assert.ok(rows[0].query_shape["+truncated"]>0);
          }
        } finally {delete Object.prototype.value;f.dispose();}
      `;
      const child = Bun.spawnSync([process.execPath, "--eval", script], {
        stdout: "pipe", stderr: "pipe", timeout: 15_000,
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(child.stdout.length).toBe(0);
      expect(child.stderr.length).toBe(0);
    });
  }
}
