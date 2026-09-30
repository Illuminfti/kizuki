import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "@kizuki/core/testing";
import { correctionKit } from "../../core/test/helpers/world-correct-kit";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(120_000);

const { cleanup, isolatedEnv, runCli, tempVault } = createHelpers();
afterEach(cleanup);

type Env = Record<string, string | undefined>;
type Card = {
  concept: { ref: { token: string } };
  definitions: Record<string, any>[];
  relations: Record<string, any>[];
};

async function world(): Promise<{ env: Env; ref: string; logic: string }> {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  try {
    const kit = correctionKit(db, setup.vault);
    await kit.declare("concept", "topic:bayes", "Bayesian updating");
    await kit.declare("concept", "topic:prob", "Probability theory");
    await kit.declare("concept", "topic:logic", "Formal logic");
    await kit.write({
      subject: "topic:bayes",
      predicate: "concept.definition",
      object: { literal: "Revise beliefs using evidence" },
    });
    await kit.write({
      subject: "topic:bayes",
      predicate: "concept.requires",
      object: { subject: "topic:prob" },
    });
    kit.materialize("topic:bayes");
  } finally {
    db.close();
  }
  return {
    env: setup.env,
    ref: find(setup.env, "Bayesian"),
    logic: find(setup.env, "Formal logic"),
  };
}

function find(env: Env, label: string): string {
  const found = runCli(
    env,
    "world",
    "--operation",
    "find_concepts",
    "--label",
    label,
    "--json",
  );
  expect(found.exitCode).toBe(0);
  return JSON.parse(found.stdout).data.data.result.data.matches[0].ref.token;
}

function card(env: Env, ref: string): Card {
  const read = runCli(
    env,
    "world",
    "--operation",
    "concept",
    "--ref",
    ref,
    "--json",
  );
  expect(read.exitCode).toBe(0);
  return JSON.parse(read.stdout).data.data.result.data;
}

describe("kizuki tell with a world claim", () => {
  test("--mode retract records a denial and --refresh-concept-ref prints the corrected concept", async () => {
    const { env, ref } = await world();
    const claim = card(env, ref).definitions[0]!["claim"].token;
    const told = runCli(
      env,
      "tell",
      "That is not what it means.",
      "--world-claim",
      claim,
      "--mode",
      "retract",
      "--refresh-concept-ref",
      ref,
    );
    expect(told.exitCode, told.stderr).toBe(0);
    expect(told.stdout).toContain(
      "Corrected: concept.definition is not Revise beliefs using evidence",
    );
    expect(told.stdout).toContain("Undo: kizuki undo ");
    expect(told.stdout).toContain("Refreshed concept: Bayesian updating");
    expect(told.stdout).toContain(
      "- concept.definition: not Revise beliefs using evidence",
    );
    expect(card(env, ref).definitions[0]).toMatchObject({
      polarity: "negative",
    });
  });

  test("--mode replace_object with --object-ref replaces a concept.requires edge and --json carries the refreshed card", async () => {
    const { env, ref, logic } = await world();
    const edge = card(env, ref).relations.find(
      (relation) => relation["predicate"] === "concept.requires",
    )!;
    const told = runCli(
      env,
      "tell",
      "It needs formal logic.",
      "--world-claim",
      edge["claim"].token,
      "--mode",
      "replace_object",
      "--object-ref",
      logic,
      "--refresh-concept-ref",
      ref,
      "--json",
    );
    expect(told.exitCode, told.stderr).toBe(0);
    const body = JSON.parse(told.stdout);
    expect(body.data.data.mode).toBe("replace_object");
    const refreshed = body.data.data.refreshedWorld.result.data as Card;
    expect(
      refreshed.relations.find(
        (relation) => relation["predicate"] === "concept.requires",
      )!["object"].ref.token,
    ).toBe(logic);
  });

  test("--mode reclassify_mode with --perspective-mode changes how the claim is held and --dry-run writes nothing", async () => {
    const { env, ref } = await world();
    const claim = card(env, ref).definitions[0]!["claim"].token;
    const preview = runCli(
      env,
      "tell",
      "Only an idea.",
      "--world-claim",
      claim,
      "--mode",
      "reclassify_mode",
      "--perspective-mode",
      "suggested",
      "--dry-run",
    );
    expect(preview.exitCode, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(
      "Would correct: concept.definition is Revise beliefs using evidence (suggested)",
    );
    expect(card(env, ref).definitions[0]).toMatchObject({
      perspective: { mode: "asserted" },
    });

    const told = runCli(
      env,
      "tell",
      "Only an idea.",
      "--world-claim",
      claim,
      "--mode",
      "reclassify_mode",
      "--perspective-mode",
      "suggested",
    );
    expect(told.exitCode, told.stderr).toBe(0);
    expect(card(env, ref).definitions[0]).toMatchObject({
      perspective: { mode: "suggested" },
      object: { value: "Revise beliefs using evidence" },
    });
  });

  test("--object replaces the value with text other than the statement", async () => {
    const { env, ref } = await world();
    const claim = card(env, ref).definitions[0]!["claim"].token;
    const told = runCli(
      env,
      "tell",
      "Beliefs follow evidence, not habit.",
      "--world-claim",
      claim,
      "--object",
      "Beliefs follow evidence",
    );
    expect(told.exitCode, told.stderr).toBe(0);
    expect(card(env, ref).definitions[0]).toMatchObject({
      object: { value: "Beliefs follow evidence" },
    });
  });

  test("a classification is refused with its reason code and a bad combination is a usage error", async () => {
    const { env, ref } = await world();
    const kind = card(env, ref).concept as unknown as {
      classificationClaims: { token: string }[];
    };
    const refused = runCli(
      env,
      "tell",
      "Actually a situation.",
      "--world-claim",
      kind.classificationClaims[0]!.token,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("classification_claim");
    const claim = card(env, ref).definitions[0]!["claim"].token;
    for (const args of [
      ["--mode", "erase"],
      ["--mode", "retract", "--object", "x"],
      ["--mode", "reclassify_mode"],
      ["--perspective-mode", "suggested"],
      ["--object", "x", "--object-vocabulary", "y"],
      ["--object-ref", "nope"],
      ["--refresh-concept-ref", "nope"],
    ]) {
      const bad = runCli(env, "tell", "x", "--world-claim", claim, ...args);
      expect(bad.exitCode, args.join(" ")).toBe(2);
      expect(bad.stderr).toContain("usage: kizuki tell");
    }
    const legacy = runCli(
      isolatedEnv(),
      "tell",
      "x",
      "--claim",
      "01J8T0Y8YAZP3GW8P6GQJ1A4KE",
      "--mode",
      "retract",
    );
    expect(legacy.exitCode).toBe(2);
  });
});
