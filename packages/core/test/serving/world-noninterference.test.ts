import { expect, test } from "bun:test";
import {
  HIDDEN_MUTATIONS,
  LEAKY_GLOBAL_COUNT,
  assertNoninterference,
  canonicalBytes,
  checkNoninterference,
  hiddenScene,
  ledgerWitness,
  worldViewCases,
  type ReadCase,
} from "../helpers/noninterference";

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

test("only at and wire-token values are normalized, and key order never matters", () => {
  const token = "T".repeat(43);
  expect(canonicalBytes({ at: "2026-01-01T00:00:00Z", b: token, a: [token, "x".repeat(42)] })).toBe(
    canonicalBytes({ a: [token.replaceAll("T", "U"), "x".repeat(42)], b: "U".repeat(43), at: "2030-05-05T00:00:00Z" }),
  );
  expect(canonicalBytes({ a: "one" })).not.toBe(canonicalBytes({ a: "two" }));
  expect(canonicalBytes({ at: 1 })).not.toBe(canonicalBytes({ at: 2 }));
});
