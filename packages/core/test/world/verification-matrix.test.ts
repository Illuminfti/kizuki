import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { WORLD_OPS } from "../../src/world/ops/registry";
import { serveWorldView } from "../../src/serving/world-view";
import { purgeEvents } from "../../src/ledger/purge";
import { HIDDEN_MUTATIONS, checkNoninterference, LEAKY_GLOBAL_COUNT } from "../helpers/noninterference";
import { WORLD_VERIFICATION_OPERATIONS, verificationCases, verificationInputs, verificationScene } from "../helpers/world-verification";

beforeEach(() => setSystemTime(new Date("2030-01-01T00:00:00.000Z")));
afterEach(() => setSystemTime());

test("every registered world operation has an executable verification scenario", () => {
  expect(WORLD_OPS.map(op => op.name).sort()).toEqual([...WORLD_VERIFICATION_OPERATIONS].sort());
});

for (const mutation of HIDDEN_MUTATIONS) {
  test(`every world operation is noninterfering under ${mutation.name}`, async () => {
    expect(await checkNoninterference({ scene: verificationScene, cases: verificationCases, mutations: [mutation] })).toEqual([]);
  }, 120_000);
}

test("verification self-test detects an injected global-count leak", async () => {
  const leaks = await checkNoninterference({ cases: () => [LEAKY_GLOBAL_COUNT], mutations: HIDDEN_MUTATIONS.filter(m => m.name === "hidden claim") });
  if (process.env.KIZUKI_VERIFY_INJECT_LEAK === "1") expect(leaks).toEqual([]);
  else expect(leaks.some(leak => leak.dimension === "bytes")).toBe(true);
}, 120_000);

test("all world operations close over purge and retained capabilities lose evidence", async () => {
  const scene = await verificationScene();
  try {
    const inputs = verificationInputs(scene);
    const baseline = new Map(WORLD_VERIFICATION_OPERATIONS.map(name => [name, serveWorldView(scene.reader, inputs[name])]));
    for (const name of WORLD_VERIFICATION_OPERATIONS) expect(baseline.get(name)?.data).toHaveProperty("result");
    const events = scene.db.query<{ event_id: string }, []>("SELECT event_id FROM events ORDER BY event_id").all();
    for (const event of events) purgeEvents(scene.db, scene.vaultPath, { event_id: event.event_id }, "verification-purge");
    for (const name of WORLD_VERIFICATION_OPERATIONS) {
      const after = serveWorldView(scene.reader, inputs[name]);
      expect(after.quoted, name).toEqual([]);
      expect(after.canon, name).toEqual([]);
      if (name === "describe") expect(after.data).toEqual(baseline.get(name)!.data);
      else if (name.startsWith("find_")) expect(after.data).toMatchObject({ result: { data: { matches: [] } } });
      else if (name === "slice") expect(after.data).toMatchObject({ result: { data: { constraints: [], detail: [] } } });
      else if (name === "frontier") expect(after.data).toMatchObject({ result: { data: { groups: [] } } });
      else if (name === "resume") expect(after.data).toEqual({ schema: "kizuki.world-view/v1", operation: "resume", result: { status: "new_view_required" } });
      else expect(after.data, name).toEqual({ status: "not_found" });
    }
  } finally { scene.dispose(); }
}, 120_000);
