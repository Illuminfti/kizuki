import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TOOLS } from "@kizuki/core";
import {
  correctionKit,
  type ClaimRef,
  type CorrectionKit,
  type WorldRef,
} from "../../core/test/helpers/world-correct-kit";
import { CORRECT_INPUT } from "../src/schemas";
import { call, connectClient, envelopeOf, errorOf } from "./client";
import { mcpFixture, type McpFixture } from "./helpers";

// Each case seeds a ledger, writes canon pages and reads them back through a real client.
setDefaultTimeout(120_000);

let fixture: McpFixture | null = null;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  fixture?.dispose();
  fixture = null;
});

const DEFINITION = "Revise beliefs using evidence";

async function seeded(): Promise<{
  running: McpFixture;
  kit: CorrectionKit;
  ref: WorldRef;
  logic: WorldRef;
}> {
  const running = mcpFixture();
  fixture = running;
  const kit = correctionKit(running.db, running.vaultPath);
  await kit.declare("concept", "topic:bayes", "Bayesian updating");
  await kit.declare("concept", "topic:prob", "Probability theory");
  await kit.declare("concept", "topic:logic", "Formal logic");
  await kit.write({
    subject: "topic:bayes",
    predicate: "concept.definition",
    object: { literal: DEFINITION },
  });
  await kit.write({
    subject: "topic:bayes",
    predicate: "concept.requires",
    object: { subject: "topic:prob" },
  });
  kit.materialize("topic:bayes");
  return {
    running,
    kit,
    ref: kit.find(kit.ctx, "concept", "Bayesian"),
    logic: kit.find(kit.ctx, "concept", "Formal logic"),
  };
}

type Client = Awaited<ReturnType<typeof connectClient>>;
type Card = {
  definitions: {
    claim: ClaimRef;
    object: { value: string };
    polarity: string;
  }[];
  relations: Record<string, any>[];
};

async function concept(client: Client, ref: WorldRef): Promise<Card> {
  const read = await call(client, "world_view", {
    operation: "concept",
    concept: ref,
  });
  expect(read.isError ?? false).toBe(false);
  return (envelopeOf(read)["data"] as { result: { data: Card } }).result.data;
}

describe("the correct tool", () => {
  test("names exactly ten tools and exactly two of them write", async () => {
    const { running } = await seeded();
    const client = await connectClient(running.owner(), open);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual([...TOOLS]);
    expect(tools).toHaveLength(10);
    expect(
      tools
        .filter((tool) => tool.annotations?.readOnlyHint === false)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["correct", "propose"]);
    const correct = tools.find((tool) => tool.name === "correct")!;
    const properties = (
      correct.inputSchema as { properties: Record<string, { enum?: string[] }> }
    ).properties;
    expect(Object.keys(properties).sort()).toEqual([
      "dry_run",
      "mode",
      "object",
      "perspective_mode",
      "refresh_world",
      "response_contract",
      "statement",
      "target",
    ]);
    expect(properties["mode"]?.enum).toEqual([
      "replace_object",
      "retract",
      "reclassify_mode",
    ]);
  });

  test("its input takes the typed forms and no others", () => {
    const token = "A".repeat(42) + "A";
    const target = { world_claim: { kind: "claim", token } };
    const ref = { kind: "object", token };
    for (const input of [
      { statement: "x", target, mode: "replace_object", object: "y" },
      {
        statement: "x",
        target,
        mode: "replace_object",
        object: { kind: "literal", value: "y" },
      },
      {
        statement: "x",
        target,
        mode: "replace_object",
        object: { kind: "vocabulary", id: "learning/assisted" },
      },
      {
        statement: "x",
        target,
        mode: "replace_object",
        object: { kind: "node", ref },
      },
      { statement: "x", target, mode: "retract" },
      {
        statement: "x",
        target,
        mode: "reclassify_mode",
        perspective_mode: "questioned",
      },
      {
        statement: "x",
        target,
        refresh_world: { operation: "concept", concept: ref },
      },
    ])
      expect(CORRECT_INPUT.safeParse(input).success).toBe(true);
    for (const input of [
      { statement: "x", target, mode: "erase" },
      { statement: "x", target, perspective_mode: "asserted" },
      { statement: "x", target, object: { kind: "node", ref: token } },
      {
        statement: "x",
        target,
        object: { kind: "literal", value: "y", extra: true },
      },
      {
        statement: "x",
        target,
        object: { kind: "literal", value: "y".repeat(401) },
      },
      { statement: "x", target, refresh_world: { operation: "find_concepts" } },
      {
        statement: "x",
        target,
        refresh_world: {
          operation: "concept",
          concept: ref,
          valid: { kind: "all" },
        },
      },
    ])
      expect(CORRECT_INPUT.safeParse(input).success).toBe(false);
  });

  test("retract denies a definition, returns the refreshed card in the same call and a second client reads it", async () => {
    const { running, ref } = await seeded();
    const owner = await connectClient(running.owner(), open);
    const other = await connectClient(running.agent("reader-private"), open);
    const before = await concept(owner, ref);
    const done = await call(owner, "correct", {
      statement: "That is not what Bayesian updating means.",
      mode: "retract",
      target: { world_claim: before.definitions[0]!.claim },
      refresh_world: { operation: "concept", concept: ref },
    });
    expect(done.isError ?? false).toBe(false);
    const data = envelopeOf(done)["data"] as Record<string, any>;
    expect(data).toMatchObject({
      mode: "retract",
      receipt_id: expect.any(String),
    });
    const refreshed = data["refreshedWorld"].result.data as Card;
    expect(refreshed.definitions).toHaveLength(1);
    expect(refreshed.definitions[0]).toMatchObject({
      polarity: "negative",
      object: { value: DEFINITION },
    });

    // The second client holds its own tokens and reads the same corrected state on its next call.
    const found = await call(other, "world_view", {
      operation: "find_concepts",
      label: "Bayesian",
    });
    const theirs = (
      envelopeOf(found)["data"] as {
        result: { data: { matches: { ref: WorldRef }[] } };
      }
    ).result.data.matches[0]!.ref;
    const seen = await concept(other, theirs);
    expect(seen.definitions).toHaveLength(1);
    expect(seen.definitions[0]!.polarity).toBe("negative");
  });

  test("replace_object names a node by the token the caller holds, and reclassify_mode changes only how the claim is held", async () => {
    const { running, ref, logic } = await seeded();
    const client = await connectClient(running.owner(), open);
    const card = await concept(client, ref);
    const edge = card.relations.find(
      (relation) => relation["predicate"] === "concept.requires",
    )!;
    const replaced = await call(client, "correct", {
      statement: "Bayesian updating needs formal logic.",
      mode: "replace_object",
      object: { kind: "node", ref: logic },
      target: { world_claim: edge["claim"] },
    });
    expect(replaced.isError ?? false).toBe(false);
    const after = await concept(client, ref);
    expect(
      after.relations.find(
        (relation) => relation["predicate"] === "concept.requires",
      )!["object"],
    ).toEqual({ kind: "node", ref: logic });

    const reclassified = await call(client, "correct", {
      statement: "Only an idea so far.",
      mode: "reclassify_mode",
      perspective_mode: "hypothetical",
      target: { world_claim: after.definitions[0]!.claim },
    });
    expect(reclassified.isError ?? false).toBe(false);
    const last = await concept(client, ref);
    expect(last.definitions[0]).toMatchObject({
      perspective: { mode: "hypothetical" },
      object: { value: DEFINITION },
    });
  });

  test("refusals reach the engine: a bad combination, a classification and a missing relay are refused and audited", async () => {
    const { running, kit, ref } = await seeded();
    const owner = await connectClient(running.owner(), open);
    const card = await concept(owner, ref);
    const target = { world_claim: card.definitions[0]!.claim };
    const badMode = await call(owner, "correct", {
      statement: "x",
      target,
      mode: "reclassify_mode",
    });
    expect(badMode.isError).toBe(true);
    expect(errorOf(badMode).error).toBe("invalid_arguments");

    const classification = (await kit.card(kit.ctx, "concept", ref))["concept"]
      .classificationClaims[0] as ClaimRef;
    const unsupported = await call(owner, "correct", {
      statement: "x",
      target: { world_claim: classification },
    });
    expect(unsupported.isError).toBe(true);
    expect(errorOf(unsupported).error).toBe("invalid_arguments");
    expect(JSON.stringify(unsupported)).toContain("classification_claim");

    const plain = await connectClient(running.agent("plain"), open);
    const denied = await call(plain, "correct", {
      statement: "x",
      target,
      mode: "retract",
    });
    expect(denied.isError).toBe(true);
    const evidence = running.db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM native_owner_evidence",
      )
      .get()!.n;
    expect(evidence).toBe(0);
  });
});
