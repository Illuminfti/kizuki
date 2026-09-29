import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "@kizuki/core/testing";
import { correctionKit } from "../../core/test/helpers/world-correct-kit";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

type Relation = {
  claim: { token: string };
  predicate: string;
  polarity: string;
  object: { kind: string; value?: string };
  perspective: { mode: string; speaker: { token: string } | null };
  context: { token: string }[];
};

function concept(env: Record<string, string | undefined>): { relations: Relation[] } {
  const found = runCli(
    env,
    "world",
    "--operation",
    "find_concepts",
    "--label",
    "Bayesian",
    "--json",
  );
  expect(found.exitCode).toBe(0);
  const ref = JSON.parse(found.stdout).data.data.result.data.matches[0].ref;
  const read = runCli(
    env,
    "world",
    "--operation",
    "concept",
    "--ref",
    ref.token,
    "--json",
  );
  expect(read.exitCode).toBe(0);
  return JSON.parse(read.stdout).data.data.result.data;
}

test("tell corrects the literal of a denied, a quoted and a contexted world claim and keeps each shape", async () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  try {
    const kit = correctionKit(db, setup.vault);
    await kit.declare("concept", "topic:bayes", "Bayesian updating");
    for (const spec of [
      {
        predicate: "concept.example",
        object: { literal: "Coin flips" },
        polarity: "negative" as const,
      },
      {
        predicate: "concept.counterexample",
        object: { literal: "Frequentist tests" },
        mode: "quoted" as const,
        speaker: "person:sam",
      },
      {
        predicate: "concept.example",
        object: { literal: "Spam filters" },
        context: ["project:mail"],
      },
    ])
      await kit.write({ subject: "topic:bayes", ...spec });
  } finally {
    db.close();
  }

  const before = concept(setup.env).relations;
  expect(before).toHaveLength(3);
  const denied = before.find((relation) => relation.polarity === "negative")!;
  const quoted = before.find(
    (relation) => relation.perspective.mode === "quoted",
  )!;
  const contexted = before.find((relation) => relation.context.length === 1)!;

  for (const [claim, statement] of [
    [denied, "Coin flips only when the coin is fair."],
    [quoted, "Null hypothesis tests."],
    [contexted, "Naive Bayes filters."],
  ] as const) {
    const told = runCli(
      setup.env,
      "tell",
      statement,
      "--world-claim",
      claim.claim.token,
      "--json",
    );
    expect(told.exitCode, told.stderr).toBe(0);
  }

  const after = concept(setup.env).relations;
  expect(after).toHaveLength(3);
  const values = after.map((relation) => relation.object.value);
  expect(values).toContain("Coin flips only when the coin is fair.");
  expect(values).toContain("Null hypothesis tests.");
  expect(values).toContain("Naive Bayes filters.");
  expect(values).not.toContain("Coin flips");
  expect(
    after.find(
      (relation) =>
        relation.object.value === "Coin flips only when the coin is fair.",
    )!.polarity,
  ).toBe("negative");
  const requoted = after.find(
    (relation) => relation.object.value === "Null hypothesis tests.",
  )!;
  expect(requoted.perspective.mode).toBe("quoted");
  expect(requoted.perspective.speaker?.token).toBe(
    quoted.perspective.speaker?.token,
  );
  expect(
    after.find((relation) => relation.object.value === "Naive Bayes filters.")!
      .context[0]?.token,
  ).toBe(contexted.context[0]?.token);
});
