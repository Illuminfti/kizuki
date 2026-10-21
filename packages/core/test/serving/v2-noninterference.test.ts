import { afterEach, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { OWNER, OWNER_AGENT_GRANT, TOOLS, addAgent, authenticate, setGrant } from "../../src/agents";
import { insertClaim } from "../../src/claims/store";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { initGraph } from "../../src/graph/schema";
import { openLedger } from "../../src/ledger/db";
import { initSearch } from "../../src/search/schema";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { referenceScope } from "../../src/world/ref-kinds/common";
import { issueClaimRef } from "../../src/world/ref-kinds/claim";
import { issueEventVersionRef } from "../../src/world/ref-kinds/evidence";
import { HIDDEN_MUTATIONS, checkNoninterference, hiddenScene, observe } from "../helpers/noninterference";
import type { NoninterferenceScene, ReadCase } from "../helpers/noninterference";
import { tempVault } from "../helpers/vault";
import { worldSeed } from "../helpers/world-seed";

setDefaultTimeout(120_000);
afterEach(() => setSystemTime());
const ABSENT_PAGE = { kind: "page", token: "A".repeat(43) } as const;
const NOT_FOUND = { code: "not_found", message: "not found" } as const;

function visibleAnchor(scene: NoninterferenceScene) {
  return scene.db.transaction(() => issueEventVersionRef(referenceScope(scene.reader), scene.visible.concept.eventId)!).immediate();
}

/** Real tool inputs. Writes use a denied hidden target, so observation never changes visible state. */
function cases(scene: NoninterferenceScene): ReadCase[] {
  const hidden = scene.db.transaction(() => {
    const scope = referenceScope({ ...scene.reader, principal: OWNER });
    return { event: issueEventVersionRef(scope, scene.hidden.eventId)!, claim: issueClaimRef(scope, scene.hidden.claims[2]!)! };
  }).immediate();
  const inputs: Record<(typeof TOOLS)[number], Record<string, unknown>> = {
    search: { query: "Bayesian", scope: "all" },
    get_page: { page: ABSENT_PAGE },
    query_entities: { type: "topic" },
    timeline: { since: "2026-01-01T00:00:00Z", until: "2030-01-01T00:00:00Z" },
    context_packet: { query: "Bayesian", budget_tokens: 1_000 },
    graph_neighbors: { anchor: visibleAnchor(scene) },
    system_health: {},
    world_view: { operation: "concept", concept: scene.refs.concept, valid: { kind: "all" }, knownAt: { kind: "current" } },
    propose: { kind: "claim", body: "A note", subject: scene.refs.concept, provenance: [hidden.event] },
    correct: { statement: "Use the revised definition.", target: hidden.claim, dry_run: true },
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

test("the v2 matrix exercises valid reads and exact scoped refusals", async () => {
  const scene = await hiddenScene();
  try {
    // Keep these assertions outside observe(), which intentionally captures
    // thrown errors so it can compare refusals across hidden mutations.
    for (const read of cases(scene)) {
      const pending = read.run(scene.reader);
      if (read.name === "get_page" || read.name === "propose" || read.name === "correct")
        await expect(pending).rejects.toMatchObject(NOT_FOUND);
      else if (read.name === "system_health")
        await expect(pending).rejects.toMatchObject({ code: "unsupported_contract", message: "requested contract unavailable" });
      else await expect(pending).resolves.toBeDefined();
    }
  } finally { scene.dispose(); }
});

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
        : tool === "search" ? { query: "Bayesian", scope: "all" } : { anchor: visibleAnchor(scene) };
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
    await expect(pending).rejects.toMatchObject(NOT_FOUND);
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
    await expect(pending).rejects.toMatchObject(NOT_FOUND);
  } finally { scene.dispose(); }
});

test("a narrowed grant refuses an in-flight async v2 packet", async () => {
  const scene = await hiddenScene();
  try {
    const pending = dispatchServeTool(scene.reader, "context_packet", { include: ["timeline"], purpose: "recall", since: "2026-01-01T00:00:00Z", until: "2030-01-01T00:00:00Z", budget_tokens: 1000 }, { response_contract: "kizuki.envelope/v2" });
    setGrant(scene.db, "narrow-reader", { subjects: [] });
    await expect(pending).rejects.toMatchObject(NOT_FOUND);
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
      run: (live) => dispatchServeTool(live, "get_page", { page: ABSENT_PAGE }, {
        response_contract: "kizuki.envelope/v2",
      }),
    };
    // Issue the principal reference before measuring either read.
    await expect(read.run(ctx)).rejects.toMatchObject(NOT_FOUND);
    const before = await observe(ctx, read);
    await worldSeed(db, { subject: "topic:hidden", floor: "private", discover: false });
    const after = await observe(ctx, read);
    expect(after).toEqual(before);
  } finally {
    db.close();
    vault.dispose();
  }
});
