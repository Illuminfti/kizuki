import { expect, setDefaultTimeout, test } from "bun:test";
import { readableWorldNode } from "../../src/world/endpoint-access";
import { worldNamespace } from "../../src/world/references";
import { assertNoninterference, type NoninterferenceScene, type ReadCase } from "../helpers/noninterference";

// Each scenario builds a real ledger, so bound the tests for a loaded host.
setDefaultTimeout(120_000);

/** What a correction learns about a node token, held to the same bar as a read. */
function nodeCase(name: string, token: string, seen: Map<string, unknown>): ReadCase {
  return {
    name,
    run: (ctx) => {
      const answer = ctx.db
        .transaction(() => readableWorldNode({ ...ctx, sourcePurpose: "correction" }, worldNamespace(ctx.db, ctx.principal), token))
        .immediate();
      seen.set(name, answer);
      return answer;
    },
  };
}

test("a correction's node check answers the same whatever hidden evidence exists", async () => {
  const seen = new Map<string, unknown>();
  await assertNoninterference({
    cases: (scene: NoninterferenceScene) => [
      nodeCase("a concept the reader holds", scene.refs.concept.token, seen),
      nodeCase("a situation the reader holds", scene.refs.situation.token, seen),
      nodeCase("the owner's token for hidden evidence", scene.hidden.ref?.token ?? "A".repeat(43), seen),
      nodeCase("a well-formed token nothing was issued for", "A".repeat(43), seen),
    ],
  });
  // The check is not vacuous: a held token names its endpoint, the rest name nothing.
  expect(seen.get("a concept the reader holds")).toMatchObject({ kind: "supplied" });
  expect(seen.get("a situation the reader holds")).toMatchObject({ kind: "supplied" });
  expect(seen.get("the owner's token for hidden evidence")).toBeNull();
  expect(seen.get("a well-formed token nothing was issued for")).toBeNull();
});
