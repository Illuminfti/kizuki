import { afterEach, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { OWNER_AGENT_GRANT, TOOLS, addAgent, authenticate, setGrant } from "../../src/agents";
import { insertClaim } from "../../src/claims/store";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { initGraph } from "../../src/graph/schema";
import { openLedger } from "../../src/ledger/db";
import { initSearch } from "../../src/search/schema";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { HIDDEN_MUTATIONS, checkNoninterference, hiddenScene, observe } from "../helpers/noninterference";
import type { NoninterferenceScene, ReadCase } from "../helpers/noninterference";
import { tempVault } from "../helpers/vault";
import { worldSeed } from "../helpers/world-seed";

setDefaultTimeout(120_000);
afterEach(() => setSystemTime());

/** Real tool inputs. Writes use a denied hidden target, so observation never changes visible state. */
function cases(scene: NoninterferenceScene): ReadCase[] {
  const inputs: Record<(typeof TOOLS)[number], Record<string, unknown>> = {
    search: { query: "Bayesian", scope: "all" },
    get_page: { id: "absent:page" },
    query_entities: { type: "topic" },
    timeline: { since: "2026-01-01T00:00:00Z", until: "2030-01-01T00:00:00Z" },
    context_packet: { query: "Bayesian", budget_tokens: 1_000 },
    graph_neighbors: { id: "absent:page" },
    system_health: {},
    world_view: { operation: "concept", concept: scene.refs.concept, valid: { kind: "all" }, knownAt: { kind: "current" } },
    propose: { kind: "claim", body: "A note", subjects: ["topic:bayes"], provenance: [scene.hidden.eventId] },
    correct: { statement: "Use the revised definition.", target: { claim_id: scene.hidden.claims[2] }, dry_run: true },
  };
  return TOOLS.map((tool) => ({
    name: tool,
    async run(ctx) {
      const envelope = await dispatchServeTool(ctx, tool, inputs[tool], { response_contract: "kizuki.envelope/v2" });
      if (tool !== "context_packet") return envelope;
      // The harness normalizes random reference tokens. A packet's content
      // digest must also compare literally, so retain it under a distinct key.
      const packet = envelope.data as { result: { view?: { token: string } } };
      return { envelope, baseline: packet.result.view?.token };
    },
  }));
}

test("all ten v2 tools preserve bytes, refusals and work counters across hidden mutations", async () => {
  setSystemTime(new Date("2026-09-30T12:00:00Z"));
  const leaks = await checkNoninterference({ cases, mutations: HIDDEN_MUTATIONS });
  expect(leaks).toEqual([]);
});

test("a timeline is sealed under the authority that authorized its chunks", async () => {
  const scene = await hiddenScene();
  try {
    const pending = dispatchServeTool(scene.reader, "timeline", {}, { response_contract: "kizuki.envelope/v2" });
    setGrant(scene.db, "narrow-reader", { subjects: [] });
    const before = await pending;
    const after = await dispatchServeTool(scene.reader, "timeline", {}, { response_contract: "kizuki.envelope/v2" });
    expect(before.quoted.length).toBeGreaterThan(0);
    expect(after.quoted).toEqual([]);
    expect(before.principal).not.toEqual(after.principal);
  } finally { scene.dispose(); }
});

test.each(["context_packet", "search", "graph_neighbors"] as const)(
  "overlapping hidden revocation does not change a v2 %s response or its work",
  async (tool) => {
    setSystemTime(new Date("2026-09-30T12:00:00Z"));
    const scene = await hiddenScene();
    try {
      const args = tool === "context_packet" ? { include: [], budget_tokens: 1000 }
        : tool === "search" ? { query: "Bayesian", scope: "all" } : { id: "absent:page" };
      const read: ReadCase = { name: tool, run: (ctx) => dispatchServeTool(ctx, tool, args, { response_contract: "kizuki.envelope/v2" }) };
      await read.run(scene.reader);
      const control = await observe(scene.reader, read);
      const pending = observe(scene.reader, read);
      revokeSourceGrant(scene.db, { source_key: scene.hidden.sourceKey, expected_revision: 1, operation_id: "overlapping-hidden-revoke" });
      expect(await pending).toEqual(control);
    } finally { scene.dispose(); }
  },
);

test.each([...HIDDEN_MUTATIONS])("overlapping $name leaves a v2 packet and its work unchanged", async (mutation) => {
  setSystemTime(new Date("2026-09-30T12:00:00Z"));
  const scene = await hiddenScene();
  try {
    const read: ReadCase = { name: "packet", run: (ctx) => dispatchServeTool(ctx, "context_packet", { budget_tokens: 1000 }, { response_contract: "kizuki.envelope/v2" }) };
    await read.run(scene.reader);
    const control = await observe(scene.reader, read);
    const pending = observe(scene.reader, read);
    await mutation.apply(scene);
    expect(await pending).toEqual(control);
  } finally { scene.dispose(); }
});

test("withdrawn visible evidence is never published by an overlapping packet read", async () => {
  const scene = await hiddenScene();
  try {
    const pending = dispatchServeTool(scene.reader, "context_packet", { include: ["timeline"], purpose: "recall", since: "2026-01-01T00:00:00Z", until: "2030-01-01T00:00:00Z", budget_tokens: 1000 }, { response_contract: "kizuki.envelope/v2" });
    revokeSourceGrant(scene.db, { source_key: scene.visible.concept.sourceKey, expected_revision: 1, operation_id: "overlapping-visible-revoke" });
    await expect(pending).rejects.toMatchObject({ code: "error" });
  } finally { scene.dispose(); }
});

test("a retained packet is not confirmed unchanged after its visible source is withdrawn", async () => {
  const scene = await hiddenScene();
  try {
    const args = { include: ["timeline"], purpose: "recall", since: "2026-01-01T00:00:00Z", until: "2030-01-01T00:00:00Z", budget_tokens: 1000 };
    const before = await dispatchServeTool(scene.reader, "context_packet", args, { response_contract: "kizuki.envelope/v2" });
    const priorView = (before.data as { result: { view: unknown } }).result.view;
    const pending = dispatchServeTool(scene.reader, "context_packet", { ...args, priorView }, { response_contract: "kizuki.envelope/v2" });
    revokeSourceGrant(scene.db, { source_key: scene.visible.concept.sourceKey, expected_revision: 1, operation_id: "retained-visible-revoke" });
    await expect(pending).rejects.toMatchObject({ code: "error" });
  } finally { scene.dispose(); }
});

test("a narrowed grant refuses an in-flight async v2 packet", async () => {
  const scene = await hiddenScene();
  try {
    const pending = dispatchServeTool(scene.reader, "context_packet", { include: ["timeline"], purpose: "recall", since: "2026-01-01T00:00:00Z", until: "2030-01-01T00:00:00Z", budget_tokens: 1000 }, { response_contract: "kizuki.envelope/v2" });
    setGrant(scene.db, "narrow-reader", { subjects: [] });
    await expect(pending).rejects.toMatchObject({ code: "error", message: "authority changed during request; retry" });
  } finally { scene.dispose(); }
});

test("hidden claim saturation leaves a scoped session packet and its work unchanged", async () => {
  setSystemTime(new Date("2026-09-30T12:00:00Z"));
  const scene = await hiddenScene();
  try {
    const read: ReadCase = { name: "session", run: (ctx) => dispatchServeTool(ctx, "context_packet", { budget_tokens: 1000 }, { response_contract: "kizuki.envelope/v2" }) };
    await read.run(scene.reader);
    const before = await observe(scene.reader, read);
    for (let index = 0; index < 60; index += 1) {
      await insertClaim({ db: scene.db }, {
        kind: "claim", subject: `person:hidden-${index}`, subjects: [`person:hidden-${index}`],
        predicate: "employment.works_at", object: "A synthetic organization", body: "A private employment fact",
        provenance: [scene.hidden.eventId], producer: "deterministic", sensitivity: "private", confidence: 0.8,
      });
    }
    expect(await observe(scene.reader, read)).toEqual(before);
  } finally { scene.dispose(); }
});

test("the first hidden source leaves v2 bytes and work unchanged across the epoch-zero boundary", async () => {
  setSystemTime(new Date("2026-09-30T12:00:00Z"));
  const vault = tempVault("kizuki-v2-policy-");
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  try {
    initSearch(db);
    initGraph(db);
    const principal = authenticate(db, addAgent(db, "scoped-reader", {
      ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["topic:visible"],
    }).token)!;
    const ctx = { db, vaultPath: vault.path, principal };
    const read: ReadCase = {
      name: "get_page",
      run: (live) => dispatchServeTool(live, "get_page", { id: "absent:page" }, {
        response_contract: "kizuki.envelope/v2",
      }),
    };
    // Issue the principal reference before measuring either read.
    await read.run(ctx);
    const before = await observe(ctx, read);
    await worldSeed(db, { subject: "topic:hidden", floor: "private", discover: false });
    const after = await observe(ctx, read);
    expect(after).toEqual(before);
  } finally {
    db.close();
    vault.dispose();
  }
});
