import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBootId } from "../../src/serve/leases";

const leases = join(import.meta.dir, "../../src/serve/leases.ts");
const uuid = "12345678-1234-4123-8123-123456789ABC";

function probe(body: string) {
  return Bun.spawnSync([process.execPath, "--eval", body], {
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
}

for (const fault of ["none", "load", "symbol", "call", "status", "short", "long", "huge", "zero-length", "missing-nul", "early-nul", "invalid", "non-ascii", "nil", "close"] as const) {
  test(`Darwin boot identity handles ${fault} and caches only a successful closed read`, () => {
    const child = probe(`
      import { strict as assert } from "node:assert";
      import { mock } from "bun:test";
      import * as ffi from "bun:ffi";
      Object.defineProperty(process,"platform",{value:"darwin"});
      Object.defineProperty(process,"arch",{value:"arm64"});
      let loads=0, calls=0, closes=0;
      const fault=${JSON.stringify(fault)}, expected=${JSON.stringify(uuid)};
      mock.module("bun:ffi",()=>({...ffi,dlopen(path, symbols) {
        loads++; assert.equal(path,"/usr/lib/libSystem.B.dylib");
        assert.deepEqual(symbols,{sysctlbyname:{args:["ptr","ptr","ptr","ptr","usize"],returns:"i32"}});
        const first=loads===1;
        if(first && fault==="load") throw new Error("synthetic load failure");
        return {symbols:first && fault==="symbol" ? {} : {sysctlbyname(key, output, size, newp, newlen) {
          calls++; assert.equal(new ffi.CString(key).toString(),"kern.bootsessionuuid");
          assert.equal(size%8,0); assert.equal(newp,null); assert.equal(newlen,0);
          const length=new BigUint64Array(ffi.toArrayBuffer(size,0,8)); assert.equal(length[0],37n);
          const bytes=new Uint8Array(ffi.toArrayBuffer(output,0,37));
          bytes.set(Buffer.from(expected+"\\0"));
          if(first) {
            if(fault==="call") throw new Error("synthetic native failure");
            if(fault==="status") return -1;
            if(fault==="short") length[0]=36n;
            if(fault==="long") length[0]=38n;
            if(fault==="huge") length[0]=0xffffffffffffffffn;
            if(fault==="zero-length") length[0]=0n;
            if(fault==="missing-nul") bytes[36]=65;
            if(fault==="early-nul") bytes[8]=0;
            if(fault==="invalid") bytes[0]=47;
            if(fault==="non-ascii") bytes[0]=0xB1;
            if(fault==="nil") bytes.set(Buffer.from("00000000-0000-0000-0000-000000000000\\0"));
          }
          return 0;
        }},close(){closes++;if(first && fault==="close")throw new Error("synthetic unload failure");}};
      }}));
      const {readBootId}=await import(${JSON.stringify(leases)});
      assert.equal(readBootId(),fault==="none" ? expected.toLowerCase() : "pid:"+process.pid);
      assert.equal(readBootId(),expected.toLowerCase());
      assert.equal(readBootId(),expected.toLowerCase());
      assert.equal(loads,fault==="none"?1:2);
      assert.equal(closes,fault==="load"||fault==="none"?1:2);
      assert.equal(calls,fault==="load"||fault==="symbol"||fault==="none"?1:2);
    `);
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.length).toBe(0);
    expect(child.stderr.length).toBe(0);
  });
}

test("unsupported Darwin architecture stays conservative without loading a library", () => {
  const child = probe(`
    import { strict as assert } from "node:assert";
    import { mock } from "bun:test";
    import * as ffi from "bun:ffi";
    Object.defineProperty(process,"platform",{value:"darwin"});
    Object.defineProperty(process,"arch",{value:"x64"});
    let loads=0;
    mock.module("bun:ffi",()=>({...ffi,dlopen(){loads++;throw new Error("must not load");}}));
    const {readBootId}=await import(${JSON.stringify(leases)});
    assert.equal(readBootId(),"pid:"+process.pid);
    assert.equal(loads,0);
  `);
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});

test.skipIf(process.platform !== "linux")("Linux boot identity still equals the kernel proc value", () => {
  expect(readBootId()).toBe(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
});

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("native Darwin boot identity agrees across processes and with sysctl", () => {
  const native = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
  expect(native.exitCode, native.stderr.toString()).toBe(0);
  const expected = native.stdout.toString().trim().toLowerCase();
  expect(expected).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(readBootId()).toBe(expected);
  expect(readBootId()).toBe(expected);
  const pids = new Set([process.pid]);
  for (let i = 0; i < 2; i++) {
    const child = probe(`import {readBootId} from ${JSON.stringify(leases)}; console.log(JSON.stringify({pid:process.pid,boot:readBootId()}));`);
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stderr.length).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.boot).toBe(expected);
    expect(Number.isSafeInteger(result.pid)).toBe(true);
    expect(pids.has(result.pid)).toBe(false);
    pids.add(result.pid);
  }
});
