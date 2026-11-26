import { expect, setSystemTime, test } from "bun:test";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { serveWorldView } from "@kizuki/core/world";
import { TYPED_EXTRACTION_KINDS } from "../../src/world/collectors";
import { readWorldKindCoverage } from "../../src/world/coverage";
import { newReadFrame } from "../../src/world/pipeline/frame";
import { readWorldMatches } from "../../src/world/pipeline/read";
import { worldNamespace } from "../../src/world/references";
import { hiddenScene, observe } from "../helpers/noninterference";
import { worldSeed } from "../helpers/world-seed";
import { cardFixture } from "./card-fixture";

test("a hidden source checkpoint cannot change card qualifiers, refusals or work counters", async () => {
  const scene = await hiddenScene();
  try {
    setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const input = { operation: "concept", concept: scene.refs.concept, valid: { kind: "all" }, knownAt: { kind: "current" } };
    const read = { name: "card coverage", run: (ctx: typeof scene.reader) => serveWorldView(ctx, input) };
    await observe(scene.reader, read);
    const before = await observe(scene.reader, read);
    const now = new Date().toISOString();
    scene.db.query(`INSERT INTO checkpoints (connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result, backfill_complete, backfill_cursor, sync_cursor)
      VALUES ('world.fixture', ?, NULL, 'sync', ?, ?, ?, 0, NULL, NULL)`).run(scene.hidden.sourceKey, now, now,
      JSON.stringify({ stored: 0, duplicates: 0, errors: [], proposals_created: 0, withdrawn: 0, retractions_filed: 0, cursor: null }));
    expect(await observe(scene.reader, read)).toEqual(before);
  } finally { scene.dispose(); setSystemTime(); }
}, 120_000);

test("readWorldKindCoverage is noninterfering across all 7 hidden typed extraction kinds, checkpoints, revocations, and purges", async () => {
  const scene = await hiddenScene();
  try {
    setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const read = { name: "kind coverage", run: (ctx: typeof scene.reader) => readWorldKindCoverage(ctx) };
    const baseline = readWorldKindCoverage(scene.reader);
    expect(baseline.total_kinds).toBe(10);
    expect(baseline.populated_kinds).toBe(2);
    expect(baseline.active_kinds).toBe(3);
    for (const kind of TYPED_EXTRACTION_KINDS) {
      expect(baseline.kinds.find((entry) => entry.kind === kind)).toMatchObject({
        classified_handles: 0,
        live_assertions: 0,
        contributing_sources: 0,
        state: "dark",
        gaps: ["coverage"],
      });
    }
    const before = await observe(scene.reader, read);

    // Seed hidden private records for all 7 typed extraction kinds and attach an incomplete hidden checkpoint.
    const hiddenSeeds = [];
    for (const kind of TYPED_EXTRACTION_KINDS) {
      hiddenSeeds.push(await worldSeed(scene.db, {
        kind,
        subject: `${kind}:hidden-privacy`,
        label: `Hidden ${kind}`,
        floor: "private",
        discover: false,
      }));
    }
    const now = new Date().toISOString();
    scene.db.query(`INSERT INTO checkpoints (connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result, backfill_complete, backfill_cursor, sync_cursor)
      VALUES ('world.fixture', ?, NULL, 'sync', ?, ?, ?, 0, NULL, NULL)`).run(hiddenSeeds[0]!.sourceKey, now, now,
      JSON.stringify({ stored: 0, duplicates: 0, errors: [], proposals_created: 0, withdrawn: 0, retractions_filed: 0, cursor: null }));
    expect(await observe(scene.reader, read)).toEqual(before);

    // Hidden revocation and hidden purge must also leave restricted kind coverage unchanged.
    revokeSourceGrant(scene.db, { source_key: hiddenSeeds[0]!.sourceKey, expected_revision: 1, operation_id: "hide-kind-revoke" });
    expect(await observe(scene.reader, read)).toEqual(before);

    purgeEvents(scene.db, scene.vaultPath, { event_id: hiddenSeeds[1]!.eventId }, "hide-kind-purge");
    expect(await observe(scene.reader, read)).toEqual(before);
  } finally {
    scene.dispose();
    setSystemTime();
  }
}, 120_000);

test("a hidden conflicting status on question or framework cannot alter a narrow reader's card conflict qualifier", async () => {
  const f = await cardFixture();
  try {
    setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/question" } }, { subject: "question:priv" });
    await f.write("question.text", { kind: "literal", value: "Is coverage private?" }, { subject: "question:priv" });
    await f.write("question.status", { kind: "vocabulary", ref: { kind: "vocabulary", id: "question/open" } }, { subject: "question:priv" });

    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/framework" } }, { subject: "framework:priv" });
    await f.write("framework.label", { kind: "literal", value: "Privacy Framework" }, { subject: "framework:priv" });
    await f.write("framework.lifecycle", { kind: "vocabulary", ref: { kind: "vocabulary", id: "framework/adopted" } }, { subject: "framework:priv" });

    const agent = addAgent(f.db, "narrow-typed-reader", {
      ...OWNER_AGENT_GRANT,
      ceiling: "public",
      subjects: ["question:priv", "framework:priv"],
    });
    const reader = { ...f.ctx, principal: authenticate(f.db, agent.token)! };

    const qFound = serveWorldView(reader, { operation: "find_questions", label: "private", valid: { kind: "all" }, knownAt: { kind: "current" } }).data;
    if (!("result" in qFound) || !("data" in qFound.result) || !("matches" in qFound.result.data)) throw new Error("question not discovered");
    const qRef = qFound.result.data.matches[0]!.ref;
    const qInput = { operation: "question", question: qRef, valid: { kind: "all" }, knownAt: { kind: "current" } };

    const readQ = { name: "question card", run: (ctx: typeof reader) => serveWorldView(ctx, qInput) };
    await observe(reader, readQ);
    const beforeQ = await observe(reader, readQ);

    let fRef!: { readonly kind: "object"; readonly token: string };
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, reader.principal);
      const fPage = readWorldMatches(newReadFrame(reader, ns, { kind: "all" }), "framework", "Privacy Framework", null, 10);
      if (fPage.matches.length !== 1) throw new Error("framework not discovered for reader");
      fRef = fPage.matches[0]!.ref;
    }).immediate();
    const fInput = { operation: "framework", framework: fRef, valid: { kind: "all" }, knownAt: { kind: "current" } };
    const readF = { name: "framework card", run: (ctx: typeof reader) => serveWorldView(ctx, fInput) };
    await observe(reader, readF);
    const beforeF = await observe(reader, readF);

    // Add a private conflicting question.status and framework.lifecycle.
    await f.write("question.status", { kind: "vocabulary", ref: { kind: "vocabulary", id: "question/abandoned" } }, { subject: "question:priv", floor: "private" });
    await f.write("framework.lifecycle", { kind: "vocabulary", ref: { kind: "vocabulary", id: "framework/rejected" } }, { subject: "framework:priv", floor: "private" });

    expect(await observe(reader, readQ)).toEqual(beforeQ);
    expect(await observe(reader, readF)).toEqual(beforeF);

    // Owner sees the conflict on both the question card and the framework card.
    const ownerQFound = serveWorldView(f.ctx, { operation: "find_questions", label: "private", valid: { kind: "all" }, knownAt: { kind: "current" } }).data;
    if (!("result" in ownerQFound) || !("data" in ownerQFound.result) || !("matches" in ownerQFound.result.data)) throw new Error("owner question missing");
    const ownerQ = serveWorldView(f.ctx, { operation: "question", question: ownerQFound.result.data.matches[0]!.ref, valid: { kind: "all" }, knownAt: { kind: "current" } }).data;
    if (!("result" in ownerQ) || !("data" in ownerQ.result) || ownerQ.result.data.schema !== "kizuki.question-card/v1") throw new Error("owner question card missing");
    expect(ownerQ.result.data.statusEvidence).toHaveLength(2);
    expect(ownerQ.result.data.statusEvidence.every((r) => r.conflict === "present")).toBe(true);

    let ownerFRef!: { readonly kind: "object"; readonly token: string };
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, f.ctx.principal);
      const ownerFPage = readWorldMatches(newReadFrame(f.ctx, ns, { kind: "all" }), "framework", "Privacy Framework", null, 10);
      if (ownerFPage.matches.length !== 1) throw new Error("owner framework missing");
      ownerFRef = ownerFPage.matches[0]!.ref;
    }).immediate();
    const ownerF = serveWorldView(f.ctx, { operation: "framework", framework: ownerFRef, valid: { kind: "all" }, knownAt: { kind: "current" } }).data;
    if (!("result" in ownerF) || !("data" in ownerF.result) || ownerF.result.data.schema !== "kizuki.framework-card/v1") throw new Error("owner framework card missing");
    expect(ownerF.result.data.lifecycle).toHaveLength(2);
    expect(ownerF.result.data.lifecycle.every((r) => r.conflict === "present")).toBe(true);
  } finally {
    f.dispose();
    setSystemTime();
  }
}, 120_000);
