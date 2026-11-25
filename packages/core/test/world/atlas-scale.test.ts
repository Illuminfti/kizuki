import { expect, test, setDefaultTimeout } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import { writeRailCursor } from "../../src/ledger/checkpoints";
import { bindSourceModelPort } from "../../src/ledger/source-grants";
import type { LlmPort } from "../../src/contracts/llm";
import { validateAtlas, type Atlas } from "../../src/contracts/atlas";
import { runWorldJobs } from "../../src/serve/world-jobs";
import { serveWorldView } from "../../src/serving/world-view";
import { EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";
import { worldSeed } from "../helpers/world-seed";

setDefaultTimeout(120_000);
const when = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const OBJECTS = 240;
const SUMMARY = "A synthetic consolidated summary.";

/** More objects than one public read may verify: the shape that collapsed the whole Atlas. */
async function largeVault(objects = OBJECTS) {
  const db = openLedger(":memory:");
  const first = await worldSeed(db, { model: EMPTY_SUMMARY_MODEL, subject: "topic:n0", label: "Concept 0" });
  for (let i = 1; i < objects; i++) {
    const kind = i % 3 === 0 ? "situation" : "concept";
    await worldSeed(db, { sourceKey: first.sourceKey, kind, subject: `${kind === "concept" ? "topic" : "situation"}:n${i}`, label: `${kind} number ${i}`, discover: false });
  }
  const last = db.query<{ accepted_at: string; event_id: string }, []>("SELECT accepted_at,event_id FROM events ORDER BY accepted_at DESC,event_id DESC LIMIT 1").get()!;
  writeRailCursor(db, "kizuki.producer.model", "extract", `${last.accepted_at}\t${last.event_id}`);
  const { model_endpoint, model } = EMPTY_SUMMARY_MODEL;
  const llm: LlmPort = bindSourceModelPort({
    descriptor: { id: "synthetic.scale", kind: "llm", contract: "kizuki.llm/v1", contract_minor: 0, supports: ["chat"], requires_lease: false, optional_package: null },
    model_ref: "synthetic.scale:complete-empty-fixture@fixture.invalid", health: async () => ({ status: "ready", detail: {} }), close: async () => {},
    complete: async () => ({ text: JSON.stringify({ schema: "kizuki.consolidation-response/v1", status: "complete", summary: SUMMARY }), model, usage: { input_tokens: 1, output_tokens: 1 } }),
  } satisfies LlmPort, { model_endpoint, model });
  return { db, first, llm };
}
function atlas(reply: ReturnType<typeof serveWorldView>): Atlas {
  if (!("result" in reply.data) || !("data" in reply.data.result) || reply.data.result.data.schema !== "kizuki.atlas/v1") throw Error(`Atlas body required: ${JSON.stringify(reply.data)}`);
  expect(validateAtlas(reply.data.result.data).ok).toBe(true);
  return reply.data.result.data;
}

test("a vault larger than one read budget still serves every Atlas panel and consolidates", async () => {
  const { db, first, llm } = await largeVault();
  try {
    // Default per-pass bounds: each pass must make durable progress from its cursor.
    for (let pass = 0; pass < 3; pass++) {
      const run = await runWorldJobs({ db, vaultPath: "", now: () => new Date().toISOString(), stopRequested: () => false, modelConfigured: true, llm });
      expect(run.errors).toEqual([]);
      expect(run.consolidation?.completed).toBe(2);
    }
    const rows = db.query<{ status: string; summary: string | null }, []>("SELECT status,summary FROM world_consolidation").all();
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row).toEqual({ status: "complete", summary: SUMMARY });

    const home = atlas(serveWorldView(first.ctx, { operation: "atlas", panel: "home", ...when }));
    expect(home.panels.map(panel => panel.panel)).toEqual(["resume", "changed", "people", "questions", "commitments", "stale", "corrections"]);
    // Home composes resume last, from what the browse panels left; asked for alone it has the whole allowance.
    expect(home.panels.find(panel => panel.panel === "resume")).toMatchObject({ reason: null });
    expect(atlas(serveWorldView(first.ctx, { operation: "atlas", panel: "resume", ...when })).panels[0]!.entries.length).toBeGreaterThan(0);
    // A budgeted panel names its own cause; it never takes the composed panels with it.
    for (const panel of home.panels.filter(panel => panel.status === "unavailable")) {
      expect(panel.reason === "budget" || panel.reason === "baseline_required").toBe(true);
      expect(panel.entries).toEqual([]);
      expect(panel.coverage).toMatchObject({ status: "partial" });
    }
    expect(home.coverage.status).toBe("partial");

    const stale = atlas(serveWorldView(first.ctx, { operation: "atlas", panel: "stale", ...when })).panels[0]!;
    expect(stale).toMatchObject({ status: "partial", reason: null });
    expect(stale.entries).toHaveLength(4);
    expect(stale.coverage.gaps).toEqual(expect.arrayContaining(["pending_consolidation", "traversal_limit"]));
    for (const entry of stale.entries) expect(entry.relations.length).toBeGreaterThan(0);
  } finally { db.close(); }
});

test("a multi-thousand-object vault serves the Atlas home browse panels and consolidates from a cold start", async () => {
  const { db, first, llm } = await largeVault(2_400);
  try {
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM world_consolidation").get()!.n).toBe(0);
    const run = await runWorldJobs({ db, vaultPath: "", now: () => new Date().toISOString(), stopRequested: () => false, modelConfigured: true, llm });
    expect(run.errors).toEqual([]);
    expect(db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM world_consolidation WHERE status='complete' AND summary=?").get(SUMMARY)!.n).toBeGreaterThan(0);

    const home = atlas(serveWorldView(first.ctx, { operation: "atlas", panel: "home", ...when }));
    // The open-ended resume slice composes last: it cannot starve a bounded browse panel.
    for (const name of ["people", "questions", "commitments", "stale"] as const)
      expect(home.panels.find(panel => panel.panel === name)).toMatchObject({ reason: null });
    // Which cards the first pass consolidated follows handle order, so only the floor is fixed.
    expect(home.panels.find(panel => panel.panel === "stale")!.entries.length).toBeGreaterThan(0);
    expect(home.panels.filter(panel => panel.reason === "budget")).toEqual([]);
  } finally { db.close(); }
}, 600_000);
