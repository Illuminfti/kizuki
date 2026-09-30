import { expect, test, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import {
  HIDDEN_MUTATIONS,
  LEAKY_GLOBAL_COUNT,
  assertNoninterference,
  canonicalBytes,
  checkNoninterference,
  hiddenScene,
  ledgerWitness,
  worldViewCases,
  type HiddenMutation,
  type ReadCase,
} from "../helpers/noninterference";
import { worldSeed } from "../helpers/world-seed";

// Each scenario builds a real ledger, so bound the tests for a loaded host.
setDefaultTimeout(120_000);

test("the four world_view operations do not change when hidden evidence changes", async () => {
  await assertNoninterference({ cases: worldViewCases });
});

test("a read with no hidden change is stable, so a difference is the mutation's", async () => {
  expect(await checkNoninterference({ cases: worldViewCases, mutations: [{ name: "nothing", apply: () => {} }] })).toEqual([]);
});

test("the mutation library covers every hidden change the program must hold constant", () => {
  expect(HIDDEN_MUTATIONS.map((mutation) => mutation.name)).toEqual([
    "hidden claim",
    "hidden source revoke",
    "hidden purge",
    "hidden identity merge",
    "hidden owner correction",
    "hidden supersession",
    "hidden dependency edge",
  ]);
});

test("every hidden mutation really changes the ledger", async () => {
  for (const mutation of HIDDEN_MUTATIONS) {
    const scene = await hiddenScene();
    try {
      const before = ledgerWitness(scene.db);
      await mutation.apply(scene);
      expect(ledgerWitness(scene.db), mutation.name).not.toBe(before);
    } finally {
      scene.dispose();
    }
  }
});

const only = (...names: string[]) => HIDDEN_MUTATIONS.filter((mutation) => names.includes(mutation.name));

test("a read that returns a global count fails the driver", async () => {
  const mutations = only("hidden claim", "hidden source revoke", "hidden purge");
  const leaks = await checkNoninterference({ cases: () => [LEAKY_GLOBAL_COUNT], mutations });
  expect(leaks.map((leak) => `${leak.mutation}: ${leak.dimension}`)).toEqual(["hidden claim: bytes", "hidden purge: bytes"]);
  await expect(assertNoninterference({ cases: () => [LEAKY_GLOBAL_COUNT], mutations: mutations.slice(0, 1) })).rejects.toThrow(
    "hidden claim changed bytes",
  );
});

test("a leak through work done or through an error is caught even when the bytes agree", async () => {
  const perClaim: ReadCase = {
    name: "self-test (one statement per claim)",
    run: (ctx) => {
      for (const row of ctx.db.query<{ claim_id: string }, []>("SELECT claim_id FROM claims").all()) {
        ctx.db.query("SELECT 1 FROM claims WHERE claim_id = ?").get(row.claim_id);
      }
      return "constant";
    },
  };
  const refusal: ReadCase = {
    name: "self-test (error text carries a count)",
    run: (ctx) => {
      throw new Error(`refused after ${ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!.n} claims`);
    },
  };
  const leaks = await checkNoninterference({
    cases: () => [perClaim, refusal],
    mutations: only("hidden claim"),
  });
  expect(leaks.map((leak) => `${leak.case}: ${leak.dimension}`).sort()).toEqual([
    "self-test (error text carries a count): error",
    "self-test (one statement per claim): stats",
  ]);
});

test("a read that fetches every claim and filters in memory is caught by the row count", async () => {
  const filterAfterwards: ReadCase = {
    name: "self-test (fetch all rows, keep the public ones)",
    run: (ctx) =>
      ctx.db
        .query<{ claim_id: string; sensitivity: string }, []>("SELECT claim_id, sensitivity FROM claims")
        .all()
        .filter((row) => row.sensitivity === "public").length,
  };
  const leaks = await checkNoninterference({ cases: () => [filterAfterwards], mutations: only("hidden claim") });
  expect(leaks.map((leak) => `${leak.case}: ${leak.dimension}`)).toEqual([
    "self-test (fetch all rows, keep the public ones): stats",
  ]);
});

test("a digest that changes with hidden evidence is reported, not normalized away", async () => {
  const digest: ReadCase = {
    name: "self-test (etag over the claim count)",
    run: (ctx) => ({
      etag: createHash("sha256")
        .update(String(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!.n))
        .digest("base64url"),
    }),
  };
  const leaks = await checkNoninterference({ cases: () => [digest], mutations: only("hidden claim") });
  expect(leaks.map((leak) => `${leak.case}: ${leak.dimension}`)).toEqual(["self-test (etag over the claim count): bytes"]);
});

test("a change the reader may see is reported on the real world cases, so a pass is not vacuous", async () => {
  const visibleDefinition: HiddenMutation = {
    name: "visible definition (positive control)",
    apply: async (scene) => {
      await worldSeed(scene.db, {
        sourceKey: scene.visible.concept.sourceKey,
        subject: "topic:bayes",
        label: "Bayesian updating",
        predicates: [{ predicate: "concept.definition", object: { kind: "literal", value: "A visible rewording" } }],
        discover: false,
      });
    },
  };
  const leaks = await checkNoninterference({ cases: worldViewCases, mutations: [visibleDefinition] });
  const bytes = leaks.filter((leak) => leak.dimension === "bytes").map((leak) => leak.case);
  expect(bytes).toContain("concept");
  expect(leaks.filter((leak) => leak.dimension === "control")).toEqual([]);
});

test("only at and the token of a wire ref are normalized, and key order never matters", () => {
  const token = "T".repeat(43);
  const ref = (value: string) => ({ kind: "object", token: value });
  expect(canonicalBytes({ at: "2026-01-01T00:00:00Z", b: ref(token), a: [ref(token), "x".repeat(42)] })).toBe(
    canonicalBytes({ a: [ref("U".repeat(43)), "x".repeat(42)], b: ref("U".repeat(43)), at: "2030-05-05T00:00:00Z" }),
  );
  expect(canonicalBytes({ a: "one" })).not.toBe(canonicalBytes({ a: "two" }));
  expect(canonicalBytes({ at: 1 })).not.toBe(canonicalBytes({ at: 2 }));
  expect(canonicalBytes({ etag: token })).not.toBe(canonicalBytes({ etag: "U".repeat(43) }));
});
