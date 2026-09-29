import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { OWNER } from "../../src/agents";
import { readWorldView } from "@kizuki/core/world";
import type { ServeContext } from "../../src/serving/types";
import { hiddenScene } from "../helpers/noninterference";
import type { NoninterferenceScene } from "../helpers/noninterference";
import { worldSeed } from "../helpers/world-seed";

// Each scene builds a real ledger, so bound the tests for a loaded host.
setDefaultTimeout(120_000);

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

const scenes: NoninterferenceScene[] = [];
afterEach(() => {
  for (const scene of scenes.splice(0)) scene.dispose();
});

async function scene(): Promise<{
  scene: NoninterferenceScene;
  owner: ServeContext;
}> {
  const made = await hiddenScene();
  scenes.push(made);
  return {
    scene: made,
    owner: { db: made.db, vaultPath: made.vaultPath, principal: OWNER },
  };
}

const concept = (
  ref: { kind: "object"; token: string },
  extra: Record<string, unknown> = {},
) => ({
  operation: "concept",
  concept: ref,
  valid: { kind: "all" },
  knownAt: { kind: "current" },
  ...extra,
});

type Read = ReturnType<typeof readWorldView>;
const resultOf = (read: Read) => {
  if (!("result" in read)) throw new Error("the read found nothing");
  return read.result;
};

describe("view tokens on world_view", () => {
  test("a reserved principal reading a Concept gets a random 43-character view token and its lifetime", async () => {
    const { scene: made, owner } = await scene();
    const before = Date.now();
    const result = resultOf(
      readWorldView(owner, concept(made.visible.concept.ref!)),
    );
    if (result.status !== "current" || !("validUntil" in result))
      throw new Error(`no view was issued: ${JSON.stringify(result)}`);
    expect(result.view.kind).toBe("view");
    expect(result.view.token).toMatch(TOKEN);
    expect(Date.parse(result.validUntil) - before).toBeGreaterThan(
      FIFTEEN_MINUTES - 5_000,
    );
    expect(Date.parse(result.validUntil) - Date.now()).toBeLessThanOrEqual(
      FIFTEEN_MINUTES,
    );
    const again = resultOf(
      readWorldView(owner, concept(made.visible.concept.ref!)),
    );
    if (again.status !== "current" || !("validUntil" in again))
      throw new Error("no second view was issued");
    expect(again.view.token).not.toBe(result.view.token);
  });

  test("a re-read with the prior view and no visible change is unchanged: the same token and no data", async () => {
    const { scene: made, owner } = await scene();
    const first = resultOf(
      readWorldView(owner, concept(made.visible.concept.ref!)),
    );
    if (first.status !== "current" || !("validUntil" in first))
      throw new Error("no view was issued");
    const second = resultOf(
      readWorldView(
        owner,
        concept(made.visible.concept.ref!, { priorView: first.view }),
      ),
    );
    expect(second).toEqual({
      status: "unchanged",
      view: first.view,
      validUntil: first.validUntil,
    });
  });

  test("a visible change returns a current view with a fresh token", async () => {
    const { scene: made, owner } = await scene();
    const first = resultOf(
      readWorldView(owner, concept(made.visible.concept.ref!)),
    );
    if (first.status !== "current" || !("validUntil" in first))
      throw new Error("no view was issued");
    await worldSeed(made.db, {
      sourceKey: made.visible.concept.sourceKey,
      subject: "topic:bayes",
      label: "Bayesian updating",
      predicates: [
        {
          predicate: "concept.definition",
          object: { kind: "literal", value: "A visible rewording" },
        },
      ],
      discover: false,
    });
    const second = resultOf(
      readWorldView(
        owner,
        concept(made.visible.concept.ref!, { priorView: first.view }),
      ),
    );
    if (second.status !== "current" || !("validUntil" in second))
      throw new Error(`expected a fresh view: ${JSON.stringify(second)}`);
    expect(second.view.token).toMatch(TOKEN);
    expect(second.view.token).not.toBe(first.view.token);
    expect(JSON.stringify(second.data)).toContain("A visible rewording");
  });

  test("a principal with no reserved partition still gets correct reads, marked not_issued", async () => {
    const { scene: made } = await scene();
    const result = resultOf(
      readWorldView(made.reader, concept(made.refs.concept)),
    );
    expect(result.status).toBe("current");
    expect("view" in result ? result.view : null).toEqual({
      status: "not_issued",
    });
    expect(
      "data" in result ? (result.data as { schema: string }).schema : null,
    ).toBe("kizuki.concept-card/v1");
  });

  test("a prior view nobody issued is new_view_required, with no data and no reason", async () => {
    const { scene: made, owner } = await scene();
    const stranger = { kind: "view", token: "A".repeat(43) };
    expect(
      resultOf(
        readWorldView(
          owner,
          concept(made.visible.concept.ref!, { priorView: stranger }),
        ),
      ),
    ).toEqual({
      status: "new_view_required",
    });
    expect(
      resultOf(
        readWorldView(
          made.reader,
          concept(made.refs.concept, { priorView: stranger }),
        ),
      ),
    ).toEqual({
      status: "new_view_required",
    });
  });
});
