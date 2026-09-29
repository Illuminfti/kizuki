import { afterEach, expect, test } from "bun:test";
import { conceptScenario, ScenarioDeferred, type ConceptScenario } from "../helpers/world-kit/scenario";

let scenario: ConceptScenario | null = null;
afterEach(() => {
  scenario?.dispose();
  scenario = null;
});

async function build(): Promise<ConceptScenario> {
  scenario = await conceptScenario();
  return scenario;
}

test("the fixture's sources, records and principals exist and the principals see what the fixture says", async () => {
  const s = await build();
  expect([...s.sources.keys()]).toEqual(["s1", "s2", "s3", "s4"]);
  expect([...s.records.keys()].sort()).toEqual(["r01", "r02", "r03", "r04", "r05", "r06"]);
  expect(await s.visibleRecords("owner")).toEqual(["r01", "r02", "r03", "r04", "r05", "r06"]);
  expect(await s.visibleRecords("g1")).toEqual(["r01", "r02", "r03", "r04", "r05", "r06"]);
  expect(await s.visibleRecords("g2")).toEqual(["r01", "r02", "r03", "r04", "r05"]);
});

test("revocation, the two exact purges and the grant narrowing leave what the fixture says they leave", async () => {
  const s = await build();
  await s.applyControl("ctl_revoke_s1");
  expect(await s.visibleRecords("g1")).toEqual(["r02", "r03", "r04", "r05", "r06"]);
  expect(await s.visibleRecords("g2")).toEqual(["r02", "r03", "r04", "r05"]);
  expect(s.retainedRecords()).toEqual(["r01", "r02", "r03", "r04", "r05", "r06"]);
  await s.applyControl("ctl_purge_s1");
  expect(s.retainedRecords()).toEqual(["r02", "r03", "r04", "r05", "r06"]);
  await s.applyControl("ctl_purge_copy");
  expect(s.retainedRecords()).toEqual(["r02", "r03", "r04", "r06"]);
  await s.applyControl("ctl_narrow_g1");
  expect(await s.visibleRecords("g1")).toEqual(["r02", "r03", "r04"]);
  expect(await s.visibleRecords("g2")).toEqual(["r02", "r03", "r04"]);
  expect(await s.visibleRecords("owner")).toEqual(["r02", "r03", "r04", "r06"]);
});

test("a control that needs a later workstream is deferred to its owner, never skipped", async () => {
  const s = await build();
  const owners: Record<string, string> = {};
  for (const id of s.controls) {
    try {
      await s.applyControl(id);
    } catch (error) {
      if (!(error instanceof ScenarioDeferred)) throw error;
      owners[id] = error.owner;
    }
  }
  expect(owners).toEqual({
    ctl_merge_concept: "IDENT",
    ctl_private_identity: "IDENT",
    ctl_job_prepare: "CONSOL",
    ctl_correct_exposure: "CORRECT",
    ctl_job_commit: "CONSOL",
  });
  await expect(s.applyControl("ctl_nothing")).rejects.toThrow("no fixture control");
});
