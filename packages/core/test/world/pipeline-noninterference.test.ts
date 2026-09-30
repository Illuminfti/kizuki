/**
 * Hidden evidence must not change what a narrow reader is served, nor the work
 * the pipeline does for it. The harness compares bytes, errors and work
 * counters; here the counters are the pipeline's own `ReadFrame.stats`, read
 * through the public seam by collecting the frames a read opens.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import {
  HIDDEN_MUTATIONS,
  checkNoninterference,
  hiddenScene,
  type ReadCase,
  type WorkStats,
} from "../helpers/noninterference";
import { collectReadFrames, withWorldPipeline } from "@kizuki/core/testing";
import { serveWorldView } from "@kizuki/core/world";
import { worldSeed } from "../helpers/world-seed";
import type { Collector } from "../../src/world/pipeline/collect";
import type { ReadFrame } from "../../src/world/pipeline/frame";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { testClock } from "../helpers/clock";
import { issueWorldRef, worldNamespace } from "../../src/world/references";

setDefaultTimeout(120_000);
// Keep request time fixed so issued lifetimes remain part of the byte comparison.
beforeEach(() => setSystemTime(new Date("2030-01-01T00:00:00.000Z")));
afterEach(() => setSystemTime());

const view = (operation: string, rest: Record<string, unknown>) => ({
  operation,
  ...rest,
  valid: { kind: "all" },
  knownAt: { kind: "current" },
});

/** A read whose bytes are compared and whose frames' counters are added up. */
function counted(name: string, input: () => Record<string, unknown>): ReadCase {
  let frames: readonly ReadFrame[] = [];
  return {
    name,
    run: (ctx) => {
      const read = collectReadFrames(() => serveWorldView(ctx, input()));
      frames = read.frames;
      return read.result;
    },
    stats: (): WorkStats => ({
      frames: frames.length,
      rowsExamined: frames.reduce((sum, frame) => sum + frame.stats.rowsExamined, 0),
      claimsVerified: frames.reduce((sum, frame) => sum + frame.stats.claimsVerified, 0),
    }),
  };
}

const named = (...names: string[]) => HIDDEN_MUTATIONS.filter((mutation) => names.includes(mutation.name));

test("hidden claims, source revocation, identity merges and purge leave concept, situation and discovery outputs and frame stats equal", async () => {
  const leaks = await checkNoninterference({
    mutations: named("hidden claim", "hidden source revoke", "hidden identity merge", "hidden purge"),
    cases: (scene) => [
      counted("find_concepts", () => view("find_concepts", { label: "Bayesian" })),
      counted("find_situations", () => view("find_situations", { label: "Launch" })),
      counted("concept", () => view("concept", { concept: scene.refs.concept })),
      counted("situation", () => view("situation", { situation: scene.refs.situation })),
    ],
  });
  expect(leaks).toEqual([]);
});

test("the frame counters are real: a read does work, and a visible change moves them", async () => {
  const leaks = await checkNoninterference({
    mutations: [
      {
        name: "visible claim (positive control)",
        apply: async (scene) => {
          await worldSeed(scene.db, {
            sourceKey: scene.visible.concept.sourceKey,
            subject: "topic:bayes",
            label: "Bayesian updating",
            predicates: [{ predicate: "concept.example", object: { kind: "literal", value: "A visible example" } }],
            discover: false,
          });
        },
      },
    ],
    cases: (scene) => [counted("concept", () => view("concept", { concept: scene.refs.concept }))],
  });
  expect(leaks.filter((leak) => leak.dimension === "control")).toEqual([]);
  expect(leaks.map((leak) => leak.dimension).sort()).toEqual(["bytes", "stats"]);
});

test("a collector that names every claim in the ledger leaks through the counters even though the bytes agree", async () => {
  const everyClaim: Collector = (frame) =>
    frame.ctx.db.query<{ claim_id: string }, []>("SELECT claim_id FROM claims").all().map((row) => row.claim_id);
  const leaks = await withWorldPipeline({ collectors: [everyClaim] }, () =>
    checkNoninterference({
      mutations: named("hidden claim"),
      cases: (scene) => [counted("concept", () => view("concept", { concept: scene.refs.concept }))],
    }),
  );
  expect(leaks.map((leak) => `${leak.mutation}: ${leak.dimension}`)).toEqual(["hidden claim: stats"]);
});

for (const restriction of [
  { name: "claim type", grant: { types: ["note"] }, asserted: "2026-02-28T10:30:00Z" },
  { name: "asserted since", grant: { since: "2026-02-28T10:30:00Z" }, asserted: "2026-01-01T00:00:00Z" },
  { name: "asserted until", grant: { until: "2026-02-28T10:30:00Z" }, asserted: "2026-04-01T00:00:00Z" },
]) {
  test(`claims denied by ${restriction.name} do not change discovery, cards, errors or work`, async () => {
    const leaks = await checkNoninterference({
      scene: async () => {
        const scene = await hiddenScene();
        scene.db.query("UPDATE claims SET asserted_at=? WHERE claim_id IN (SELECT value FROM json_each(?))")
          .run(restriction.asserted, JSON.stringify([...scene.visible.concept.claims, ...scene.visible.situation.claims]));
        const agent = addAgent(scene.db, "claim-restricted", {
          ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["topic:bayes", "project:launch"],
          ...restriction.grant,
        });
        const principal = authenticate(scene.db, agent.token)!;
        // Seed opaque refs in this grant's namespace so card reads reach claim
        // collection rather than merely refusing another principal's tokens.
        const refs = scene.db.transaction(() => {
          const ns = worldNamespace(scene.db, principal);
          const ref = (subject: string) => {
            const handle = scene.db.query<{ handle_id: string }, [string]>(
              "SELECT handle_id FROM semantic_bindings WHERE raw_id=?",
            ).get(subject)!.handle_id;
            return issueWorldRef(scene.db, ns, "object", handle);
          };
          return { concept: ref("topic:bayes"), situation: ref("project:launch") };
        })();
        return { ...scene, refs, reader: { ...scene.reader, principal } };
      },
      mutations: [{
        name: "denied claim on readable evidence",
        apply: async (scene) => {
          for (const kind of ["concept", "situation"] as const) {
            await worldSeed(scene.db, {
              kind, sourceKey: scene.visible[kind].sourceKey,
              subject: kind === "concept" ? "topic:bayes" : "project:launch",
              label: "Denied alias", clock: testClock(restriction.asserted), discover: false,
            });
          }
        },
      }, {
        name: "denied lifecycle change",
        apply: (scene) => {
          scene.db.query("UPDATE claims SET status='reverted' WHERE claim_id IN (SELECT value FROM json_each(?))")
            .run(JSON.stringify([...scene.visible.concept.claims, ...scene.visible.situation.claims]));
        },
      }],
      cases: (scene) => [
        counted("find_concepts empty label", () => view("find_concepts", { label: "" })),
        counted("find_situations empty label", () => view("find_situations", { label: "" })),
        counted("find_concepts alias", () => view("find_concepts", { label: "Denied" })),
        counted("find_situations alias", () => view("find_situations", { label: "Denied" })),
        counted("concept", () => view("concept", { concept: scene.refs.concept })),
        counted("situation", () => view("situation", { situation: scene.refs.situation })),
      ],
    });
    expect(leaks).toEqual([]);
  });
}
