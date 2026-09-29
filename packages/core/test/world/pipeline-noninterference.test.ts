/**
 * Hidden evidence must not change what a narrow reader is served, nor the work
 * the pipeline does for it. The harness compares bytes, errors and work
 * counters; here the counters are the pipeline's own `ReadFrame.stats`, read
 * through the public seam by collecting the frames a read opens.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import {
  HIDDEN_MUTATIONS,
  checkNoninterference,
  type ReadCase,
  type WorkStats,
} from "../helpers/noninterference";
import { serveWorldView } from "../../src/serving/world-view";
import { worldSeed } from "../helpers/world-seed";
import type { Collector } from "../../src/world/pipeline/collect";
import { collectReadFrames, type ReadFrame } from "../../src/world/pipeline/frame";
import { withWorldPipeline } from "../../src/world/pipeline/read";

setDefaultTimeout(120_000);

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
