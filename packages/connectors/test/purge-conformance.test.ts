import { expect, test } from "bun:test";
import { HealthReport, KizukiError, freezeManifest } from "@kizuki/core";
import type { Connector, PurgePlan } from "@kizuki/core";
import { runConformance } from "../src/testkit";
import type { PurgeConformanceFactory } from "../src/testkit";

const ID = "kizuki.synthetic-purge";
function connector(purgeSource: Connector["purgeSource"], purge = true): Connector {
  const absent = async (): Promise<never> => { throw new KizukiError("not_supported", "synthetic capability absent"); };
  const manifest = freezeManifest({ schema: "kizuki.connector/v1" as const, connector_id: ID,
    version: "1", contract_minor: 1, implementation: "synthetic-purge-fixture", allowed_egress: [],
    cursor_schema: null, kinds: ["message"], capabilities: { backfill: false, sync: false, tombstones: false, purge, fixture: false },
    required_secrets: [], emits_sensitivity_hint: false, default_sensitivity: "private" as const,
    sensitivity_floor: "private" as const, auth_modes: ["none" as const] });
  return { manifest: () => manifest, health: async () => new HealthReport({state:"ok", checked_at:"2026-09-01T00:00:00Z"}),
    connect: async () => {}, backfill: absent, sync: absent, fixture: absent, revoke: async () => {}, purgeSource };
}
const digest = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
type Fault = "none" | "adds-record" | "unknown-plan-field" | "missing-completeness" | "incomplete" | "wrong-id" | "wrong-subject" | "duplicate" | "overlap" |
  "destructive-plan" | "body-mutation" | "retains-removed" | "removes-unreachable" | "changes-unrelated" |
  "negative-proof" | "short-proof" | "missing-proof" | "stale-replan" | "destructive-replan" | "executor-error" | "dispose-error";
function factory(fault: Fault = "none", readOnly = false) {
  const counts = { base: 0, plans: 0, executed: 0, verified: 0, disposed: 0 };
  const base = connector(async () => { counts.base++; throw new Error("configured purge must never be called"); });
  const create: PurgeConformanceFactory = async () => {
    const source = new Map([["selected-a", "alpha"], ["selected-b", "beta"], ["unreachable", "retained"], ["unrelated", "independent"]]);
    const removable = readOnly ? [] : ["selected-a", "selected-b"];
    const unreachable = readOnly ? ["selected-a", "selected-b", "unreachable"] : ["unreachable"];
    const isolated = connector(async subject_id => {
      counts.plans++;
      const plan: PurgePlan = { subject_id, source_record_ids: removable.filter(id => source.has(id)), unreachable_source_record_ids: unreachable, complete: true };
      if (fault === "missing-completeness") delete plan.complete;
      if (fault === "unknown-plan-field") Object.assign(plan, { additional_removal_ids: ["unrelated"] });
      if (fault === "incomplete") { plan.complete = false; plan.continuation = "synthetic-next"; }
      if (fault === "wrong-id") plan.source_record_ids = ["unrelated"];
      if (fault === "wrong-subject") plan.subject_id = "synthetic:other";
      if (fault === "duplicate") plan.source_record_ids = ["selected-a", "selected-a"];
      if (fault === "overlap") plan.unreachable_source_record_ids = ["selected-a", "unreachable"];
      if (fault === "destructive-plan") source.delete("selected-a");
      if (fault === "body-mutation") source.set("unrelated", "changed during planning");
      if (fault === "adds-record") source.set("new-record", "unexpected source addition");
      if (fault === "stale-replan" && counts.plans > 1) plan.source_record_ids = removable;
      if (fault === "destructive-replan" && counts.plans > 1) source.delete("unrelated");
      return plan;
    });
    return { connector: isolated, subject_id: "synthetic:selected", removable_ids: removable,
      unreachable_ids: unreachable, unrelated_ids: ["unrelated"],
      snapshot: async () => [...source].map(([source_record_id, text]) => ({ source_record_id, sha256: digest(text) })),
      execute: async plan => {
        counts.executed++;
        expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.source_record_ids)).toBe(true);
        expect(plan.subject_id).toBe("synthetic:selected"); expect([...plan.source_record_ids]).toEqual(removable);
        if (fault === "executor-error") throw new Error("synthetic private provider diagnostic");
        for (const id of plan.source_record_ids) if (fault !== "retains-removed") source.delete(id);
        if (fault === "removes-unreachable") source.delete("unreachable");
        if (fault === "changes-unrelated") source.set("unrelated", "changed during execution");
      },
      verifyAbsent: async ids => {
        counts.verified++;
        if (fault === "missing-proof") return undefined as never;
        return { checked: fault === "short-proof" ? 0 : ids.length,
          found: fault === "negative-proof" ? ["selected-b"] : ids.filter(id => source.has(id)) };
      },
      dispose: async () => { counts.disposed++; source.clear(); if (fault === "dispose-error") throw Error("synthetic cleanup failed"); },
    };
  };
  return { base, create, counts };
}

test("purge requires an isolated factory before invoking the configured purge method", async () => {
  const f = factory(); const result = await runConformance(f.base);
  expect(result.pass).toBe(false); expect(result.failures).toContain("purge capability requires an isolated synthetic fixture factory; configured purgeSource was not called");
  expect(f.counts.base).toBe(0); expect(f.counts.plans).toBe(0);
});
for (const readOnly of [false, true]) test(`owned fixture proves exact planning, execution, absence and retained records (${readOnly ? "unreachable source" : "removable source"})`, async () => {
  const f = factory("none", readOnly), result = await runConformance(f.base, {purgeFixture:f.create});
  expect(result).toEqual({pass:true,failures:[]});
  expect(f.counts).toEqual({base:0,plans:2,executed:1,verified:1,disposed:1});
});
for (const fault of ["adds-record", "unknown-plan-field", "missing-completeness", "incomplete", "wrong-id", "wrong-subject", "duplicate", "overlap", "destructive-plan", "body-mutation"] as const) {
  test(`purge refuses ${fault} before fixture execution`, async () => {
    const f = factory(fault), result = await runConformance(f.base,{purgeFixture:f.create});
    expect(result.pass).toBe(false); expect(result.failures.length).toBeGreaterThan(0);
    expect(f.counts).toEqual({base:0,plans:1,executed:0,verified:0,disposed:1});
  });
}
for (const fault of ["retains-removed", "removes-unreachable", "changes-unrelated", "negative-proof", "short-proof", "missing-proof", "stale-replan", "destructive-replan", "executor-error", "dispose-error"] as const) {
  test(`purge qualification rejects ${fault}`, async () => {
    const f = factory(fault), result = await runConformance(f.base,{purgeFixture:f.create});
    expect(result.pass).toBe(false); expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.join()).not.toContain("private provider"); expect(f.counts.base).toBe(0); expect(f.counts.disposed).toBe(1);
  });
}
test("the factory cannot return the configured connector", async () => {
  const f=factory(), result=await runConformance(f.base,{purgeFixture:async()=>({...await f.create(),connector:f.base})});
  expect(result.pass).toBe(false); expect(f.counts.base).toBe(0); expect(f.counts.executed).toBe(0); expect(f.counts.disposed).toBe(1);
});
test("fixture ID partitions require selected and independent records without overlap", async () => {
  for(const bad of [{removable_ids:[],unreachable_ids:[]},{unrelated_ids:[]},{unrelated_ids:["selected-a"]},{subject_id:""},{removable_ids:Array(10001).fill("selected-a")}]){
    const f=factory(),result=await runConformance(f.base,{purgeFixture:async()=>({...await f.create(),...bad})});
    expect(result.pass).toBe(false);expect(f.counts.plans).toBe(0);expect(f.counts.disposed).toBe(1);
  }
});
test("absent purge remains a real not_supported check and does not invoke a factory", async () => {
  let calls=0,created=0;
  const absent=connector(async()=>{calls++;throw new KizukiError("not_supported","no source deletion");},false);
  expect((await runConformance(absent,{purgeFixture:async()=>{created++;return factory().create();}})).pass).toBe(true);
  expect(calls).toBe(1);expect(created).toBe(0);
  absent.purgeSource=async subject_id=>({subject_id,source_record_ids:[],unreachable_source_record_ids:[],complete:true});
  expect((await runConformance(absent)).pass).toBe(false);
});


test("a fixture for a different implementation refuses before planning", async () => {
  const f = factory();
  const result = await runConformance(f.base, { purgeFixture: async () => {
    const fixture = await f.create();
    const original = fixture.connector.manifest();
    fixture.connector.manifest = () => ({ ...original, implementation: "different-fixture" });
    return fixture;
  } });
  expect(result.pass).toBe(false);
  expect(f.counts).toEqual({ base: 0, plans: 0, executed: 0, verified: 0, disposed: 1 });
});

for (const field of ["subject_id", "source_record_ids", "unreachable_source_record_ids", "complete", "continuation", "array-element"] as const) {
  test(`purge admission refuses ${field} accessors without invoking them`, async () => {
    const f = factory(); let invoked = 0;
    const result = await runConformance(f.base, { purgeFixture: async () => {
      const fixture = await f.create(), original = fixture.connector.purgeSource.bind(fixture.connector);
      fixture.connector.purgeSource = async subject => {
        const raw = await original(subject);
        const target = field === "array-element" ? raw.source_record_ids : raw;
        const key = field === "array-element" ? "0" : field;
        const value = Reflect.get(target, key);
        Object.defineProperty(target, key, { enumerable: true, get() { invoked++; return value; } });
        return raw;
      };
      return fixture;
    } });
    expect(result.pass).toBe(false); expect(invoked).toBe(0);
    expect(f.counts.executed).toBe(0); expect(f.counts.disposed).toBe(1);
  });
}

test("a late factory fixture is disposed exactly once after admission times out", async () => {
  const f = factory();
  let release!: () => void, finished!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const disposed = new Promise<void>(resolve => { finished = resolve; });
  const run = await runConformance(f.base, { deadlineMs: 5, purgeFixture: async () => {
    const fixture = await f.create(); await gate;
    const dispose = fixture.dispose.bind(fixture);
    fixture.dispose = async () => { await dispose(); finished(); };
    return fixture;
  } });
  expect(run.pass).toBe(false); expect(f.counts.disposed).toBe(0);
  release();
  await Promise.race([disposed, Bun.sleep(100)]);
  expect(f.counts).toEqual({base:0,plans:0,executed:0,verified:0,disposed:1});
  await Bun.sleep(10); expect(f.counts.disposed).toBe(1);
});
