import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_AGENT_GRANT, addAgent, authenticate, type Tool } from "../../src/agents";
import { undoReceipt } from "../../src/canon/undo";
import {
  worldCanonPath,
  worldClaimHandle,
} from "../../src/canon/world-materialization";
import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import { getClaim } from "../../src/claims/store";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { sourceRecordId } from "../../src/correction/parse";
import { serveCorrect } from "../../src/serving/correct";
import type { CorrectArgs } from "../../src/serving/correct";
import { assertWorldState } from "../../src/world/integrity";
import {
  correctionKit,
  worldData,
  type AssertionSpec,
  type ClaimRef,
  type WorldRef,
} from "../helpers/world-correct-kit";
import { tempVault } from "../helpers/vault";
import { startLoopback } from "../helpers/world-kit/loopback";

// Every case builds a ledger and rewrites canon pages, and the host is often loaded.
setDefaultTimeout(120_000);

const DEFINITION = "Revise beliefs using evidence";

async function scene() {
  const vault = tempVault();
  const db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  const kit = correctionKit(db, vault.path);
  await kit.declare("concept", "topic:bayes", "Bayesian updating");
  await kit.declare("concept", "topic:prob", "Probability theory");
  await kit.declare("concept", "topic:logic", "Formal logic");
  const definition = await kit.write({
    subject: "topic:bayes",
    predicate: "concept.definition",
    object: { literal: DEFINITION },
  });
  const requires = await kit.write({
    subject: "topic:bayes",
    predicate: "concept.requires",
    object: { subject: "topic:prob" },
  });
  kit.materialize("topic:bayes");
  const ref = kit.find(kit.ctx, "concept", "Bayesian");
  return {
    vault,
    db,
    kit,
    ref,
    logic: kit.find(kit.ctx, "concept", "Formal logic"),
    definition,
    requires,
    card: () => kit.card(kit.ctx, "concept", ref),
    page: () =>
      readFileSync(
        join(vault.path, worldCanonPath(worldClaimHandle(db, definition)!)),
        "utf8",
      ),
    dispose: () => {
      db.close();
      vault.dispose();
    },
  };
}
type Scene = Awaited<ReturnType<typeof scene>>;

function definitionRef(card: Record<string, any>): ClaimRef {
  return card["definitions"][0].claim;
}
function relationOf(
  card: Record<string, any>,
  predicate: string,
): Record<string, any> {
  return card["relations"].find(
    (item: { predicate: string }) => item.predicate === predicate,
  );
}
const nativeEvidence = (s: Scene) =>
  s.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM native_owner_evidence")
    .get()!.n;

test.each([
  { mode: "quoted", speaker: "person:sam" },
  { mode: "quoted" },
  { mode: "reported" },
  { holder: "person:sam" },
  { speaker: "person:sam" },
  { addressee: "person:sam" },
] satisfies Partial<AssertionSpec>[])("all correction modes preserve an attributed claim (%j)", async (perspective) => {
  const s = await scene();
  try {
    const id = await s.kit.write({
      subject: "topic:bayes",
      predicate: "concept.counterexample",
      object: { literal: "Frequentist tests" },
      ...perspective,
    });
    s.kit.materialize("topic:bayes");
    const before = s.card();
    const page = s.page();
    const claim = getClaim(s.db, id);
    const meaning = readClaimV2Semantic(s.db, id);
    const tables = ["events", "claims", "claim_v2_support", "canon_receipts", "claim_supersessions"];
    const counts = () => tables.map(table => s.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    const recorded = counts();
    const target = { world_claim: relationOf(before, "concept.counterexample")["claim"] };
    const attempts: CorrectArgs[] = [
      { target, statement: "Null hypothesis tests.", mode: "replace_object" },
      { target, statement: "Nope, wrong.", mode: "retract" },
      { target, statement: "That was an idea.", mode: "reclassify_mode", perspective_mode: "suggested" },
    ];
    for (const args of attempts) {
      for (const dry_run of [false, true]) {
        await expect(serveCorrect(s.kit.ctx, { ...args, dry_run })).rejects.toThrow("unsupported_assertion: quoted_attribution");
        expect(nativeEvidence(s)).toBe(0);
        expect(counts()).toEqual(recorded);
        expect(getClaim(s.db, id)).toEqual(claim);
        expect(readClaimV2Semantic(s.db, id)).toEqual(meaning);
        expect(s.card()).toEqual(before);
        expect(s.page()).toBe(page);
      }
    }
    const audits = s.db.query<{ served: string; denied: string }, []>("SELECT served, denied FROM agent_audit WHERE tool='correct'").all();
    expect(audits).toHaveLength(6);
    for (const audit of audits) {
      expect(JSON.parse(audit.served)).toEqual([]);
      expect(JSON.parse(audit.denied)).toEqual([{ id: "tool:correct", reason: "invalid_arguments" }]);
    }
    assertWorldState(s.db);
  } finally {
    s.dispose();
  }
});

test("replace_object files the named literal beside the owner's words, rewrites the page and undoes", async () => {
  const s = await scene();
  try {
    const statement =
      "Posterior beliefs follow prior beliefs and the likelihood.";
    const object = {
      kind: "literal" as const,
      value: "Posterior is proportional to prior times likelihood",
    };
    const done = await serveCorrect(s.kit.ctx, {
      statement,
      object,
      mode: "replace_object",
      target: { world_claim: definitionRef(s.card()) },
    });
    expect(done.data).toMatchObject({
      mode: "replace_object",
      refreshedWorld: null,
    });
    const receipt = done.data!.receipt_id!;
    expect(receipt).toBeString();
    expect(getClaim(s.db, s.definition)!.status).toBe("superseded");
    expect(s.card()["definitions"][0].object.value).toBe(object.value);
    expect(s.page()).toContain(statement);
    expect(
      s.db
        .query(
          "SELECT 1 FROM claim_v2_support WHERE claim_id=? AND support_origin='native_owner'",
        )
        .get(done.data!.claim_id!),
    ).not.toBeNull();
    assertWorldState(s.db);

    await undoReceipt({ db: s.db, vault_path: s.vault.path }, receipt);
    expect(getClaim(s.db, s.definition)!.status).toBe("live");
    expect(getClaim(s.db, done.data!.claim_id!)!.status).toBe("reverted");
    expect(s.card()["definitions"][0].object.value).toBe(DEFINITION);
    expect(s.page()).not.toContain(statement);
  } finally {
    s.dispose();
  }
});

test("replace_object replaces a concept.requires edge with another node and the edge survives backup and restore", async () => {
  const s = await scene();
  const out = tempVault();
  const destination = tempVault();
  try {
    const edge = relationOf(s.card(), "concept.requires");
    expect(edge["object"]).toEqual({
      kind: "node",
      ref: expect.objectContaining({ kind: "object" }),
    });
    const done = await serveCorrect(s.kit.ctx, {
      statement:
        "Bayesian updating needs formal logic, not probability theory.",
      mode: "replace_object",
      object: { kind: "node", ref: s.logic },
      target: { world_claim: edge["claim"] },
    });
    const receipt = done.data!.receipt_id!;
    expect(receipt).toBeString();
    expect(getClaim(s.db, s.requires)!.status).toBe("superseded");
    expect(relationOf(s.card(), "concept.requires")["object"]).toEqual({
      kind: "node",
      ref: s.logic,
    });
    const meaning = readClaimV2Semantic(s.db, done.data!.claim_id!)!;
    expect(meaning).toMatchObject({
      predicate: "concept.requires",
      object: { kind: "subject", ref: { id: "topic:logic" } },
    });
    assertWorldState(s.db);

    const backup = join(out.path, "backup");
    const restored = join(destination.path, "restored");
    await exportVault(s.db, s.vault.path, backup);
    restoreVault(backup, restored);
    const copy = openLedger(join(restored, ".kizuki/kizuki.db"));
    try {
      assertWorldState(copy);
      expect(readClaimV2Semantic(copy, done.data!.claim_id!)).toEqual(meaning);
    } finally {
      copy.close();
    }

    await undoReceipt({ db: s.db, vault_path: s.vault.path }, receipt);
    expect(getClaim(s.db, s.requires)!.status).toBe("live");
    expect(
      relationOf(s.card(), "concept.requires")["object"].ref.token,
    ).not.toBe(s.logic.token);
  } finally {
    s.dispose();
    out.dispose();
    destination.dispose();
  }
});

test("a literal cannot replace a node, and the refusal leaves no native evidence", async () => {
  const s = await scene();
  try {
    const edge = relationOf(s.card(), "concept.requires");
    await expect(
      serveCorrect(s.kit.ctx, {
        statement: "Needs logic.",
        target: { world_claim: edge["claim"] },
      }),
    ).rejects.toThrow("world_object_kind");
    expect(nativeEvidence(s)).toBe(0);
    expect(getClaim(s.db, s.requires)!.status).toBe("live");
  } finally {
    s.dispose();
  }
});

test("retract records the owner's denial of the same object, rewrites the page and undoes", async () => {
  const s = await scene();
  try {
    const statement = "That is not what Bayesian updating means.";
    const done = await serveCorrect(s.kit.ctx, {
      statement,
      mode: "retract",
      target: { world_claim: definitionRef(s.card()) },
    });
    const receipt = done.data!.receipt_id!;
    expect(done.data).toMatchObject({ mode: "retract" });
    expect(done.data!.answer).toContain(
      `concept.definition is not ${DEFINITION}`,
    );
    expect(getClaim(s.db, s.definition)!.status).toBe("superseded");
    const denied = s.card()["definitions"];
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      polarity: "negative",
      object: { kind: "literal", value: DEFINITION },
    });
    expect(s.page()).toContain(statement);

    await undoReceipt({ db: s.db, vault_path: s.vault.path }, receipt);
    expect(getClaim(s.db, s.definition)!.status).toBe("live");
    expect(s.card()["definitions"][0].polarity).toBe("positive");
    expect(s.page()).not.toContain(statement);
  } finally {
    s.dispose();
  }
});

test("retract refuses a claim that already denies its object", async () => {
  const s = await scene();
  try {
    await s.kit.write({
      subject: "topic:bayes",
      predicate: "concept.example",
      object: { literal: "Coin flips" },
      polarity: "negative",
    });
    const denied = relationOf(s.card(), "concept.example");
    await expect(
      serveCorrect(s.kit.ctx, {
        statement: "Forget that.",
        mode: "retract",
        target: { world_claim: denied["claim"] },
      }),
    ).rejects.toThrow("already denies");
    expect(nativeEvidence(s)).toBe(0);
  } finally {
    s.dispose();
  }
});

test("reclassify_mode moves an asserted objective to uncertainty and leaves the original claim's record alone", async () => {
  const vault = tempVault();
  const db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const kit = correctionKit(db, vault.path);
    await kit.declare("situation", "project:launch", "Launch plan");
    const objective = await kit.write({
      subject: "project:launch",
      predicate: "situation.objective",
      object: { literal: "Ship on Friday" },
    });
    kit.materialize("project:launch");
    const ref = kit.find(kit.ctx, "situation", "Launch");
    const before = kit.card(kit.ctx, "situation", ref);
    expect(before["objective"]).toMatchObject({
      object: { value: "Ship on Friday" },
    });
    expect(before["uncertainty"]).toEqual([]);
    const recorded = readClaimV2Semantic(db, objective);

    const done = await serveCorrect(kit.ctx, {
      statement: "That was an idea, not a decision.",
      mode: "reclassify_mode",
      perspective_mode: "suggested",
      target: { world_claim: before["objective"].claim },
    });
    const receipt = done.data!.receipt_id!;
    const after = kit.card(kit.ctx, "situation", ref);
    expect(after["objective"]).toBeNull();
    expect(after["uncertainty"]).toHaveLength(1);
    expect(after["uncertainty"][0]).toMatchObject({
      object: { value: "Ship on Friday" },
      perspective: { mode: "suggested" },
      assessments: [
        { authority: "owner_correction", epistemicKind: "owner_assertion" },
      ],
    });
    expect(getClaim(db, objective)!.status).toBe("superseded");
    expect(readClaimV2Semantic(db, objective)).toEqual(recorded);

    await undoReceipt({ db, vault_path: vault.path }, receipt);
    expect(kit.card(kit.ctx, "situation", ref)["objective"]).toMatchObject({
      object: { value: "Ship on Friday" },
    });
  } finally {
    db.close();
    vault.dispose();
  }
});

test("a correction keeps polarity, context and node objects and leaves quoted claims unchanged", async () => {
  const s = await scene();
  try {
    await s.kit.write({
      subject: "topic:bayes",
      predicate: "concept.example",
      object: { literal: "Coin flips" },
      polarity: "negative",
    });
    await s.kit.write({
      subject: "topic:bayes",
      predicate: "concept.counterexample",
      object: { literal: "Frequentist tests" },
      mode: "quoted",
      speaker: "person:sam",
    });
    await s.kit.write({
      subject: "topic:bayes",
      predicate: "concept.example",
      object: { literal: "Spam filters" },
      context: ["project:mail"],
    });
    const shapes = s
      .card()
      ["relations"].filter(
        (item: { predicate: string }) => item.predicate !== "concept.requires",
      );
    expect(shapes).toHaveLength(3);
    const seen = new Map<string, Record<string, any>>(
      shapes.map((item: Record<string, any>) => [item["object"].value, item]),
    );

    const denied = await serveCorrect(s.kit.ctx, {
      statement: "Fair coin flips.",
      target: { world_claim: seen.get("Coin flips")!["claim"] },
    });
    await expect(serveCorrect(s.kit.ctx, {
      statement: "Null hypothesis tests.",
      target: { world_claim: seen.get("Frequentist tests")!["claim"] },
    })).rejects.toThrow("unsupported_assertion: quoted_attribution");
    const contexted = await serveCorrect(s.kit.ctx, {
      statement: "Naive Bayes filters.",
      target: { world_claim: seen.get("Spam filters")!["claim"] },
    });
    for (const done of [denied, contexted])
      expect(done.data!.claim_id).toBeString();

    const after = new Map<string, Record<string, any>>(
      s
        .card()
        ["relations"].map((item: Record<string, any>) => [
          item["object"].value,
          item,
        ]),
    );
    expect(after.get("Fair coin flips.")).toMatchObject({
      polarity: "negative",
    });
    expect(after.has("Null hypothesis tests.")).toBe(false);
    expect(after.get("Frequentist tests")).toEqual(seen.get("Frequentist tests"));
    expect(after.get("Naive Bayes filters.")!["context"]).toEqual(
      seen.get("Spam filters")!["context"],
    );
    assertWorldState(s.db);

    const retracted = await serveCorrect(s.kit.ctx, {
      statement: "Bayesian updating does not need probability theory.",
      mode: "retract",
      target: {
        world_claim: relationOf(s.card(), "concept.requires")["claim"],
      },
    });
    expect(retracted.data!.claim_id).toBeString();
    expect(relationOf(s.card(), "concept.requires")).toMatchObject({
      polarity: "negative",
      object: { kind: "node" },
    });
    assertWorldState(s.db);
  } finally {
    s.dispose();
  }
});

test("a corrected contexted claim survives the purge of the source that named its context", async () => {
  const s = await scene();
  try {
    const contextedId = await s.kit.write({
      subject: "topic:bayes",
      predicate: "concept.counterexample",
      object: { literal: "Frequentist tests" },
      context: ["project:mail"],
    });
    const source = getClaim(s.db, contextedId)!.provenance[0]!;
    const target = relationOf(s.card(), "concept.counterexample");
    const done = await serveCorrect(s.kit.ctx, {
      statement: "Null hypothesis tests.",
      target: { world_claim: target["claim"] },
    });
    purgeEvents(
      s.db,
      s.vault.path,
      { event_id: source },
      "correct-context-source-erased",
    );
    expect(getClaim(s.db, done.data!.claim_id!)!.status).toBe("live");
    assertWorldState(s.db);
    const survivor = relationOf(s.card(), "concept.counterexample");
    expect(survivor["object"].value).toBe("Null hypothesis tests.");
    expect(survivor["perspective"].mode).toBe("asserted");
    expect(survivor["context"]).toEqual(target["context"]);
  } finally {
    s.dispose();
  }
});

test("a classification is not corrected in place and the refusal names its reason code", async () => {
  const s = await scene();
  try {
    const kind = s.card()["concept"]["classificationClaims"][0];
    await expect(
      serveCorrect(s.kit.ctx, {
        statement: "Actually a situation.",
        target: { world_claim: kind },
      }),
    ).rejects.toThrow("unsupported_assertion: classification_claim");
    expect(nativeEvidence(s)).toBe(0);
  } finally {
    s.dispose();
  }
});

test("dry_run names the change and writes nothing in every mode", async () => {
  const s = await scene();
  try {
    const tables = [
      "events",
      "claims",
      "claim_v2_support",
      "native_owner_evidence",
      "canon_receipts",
      "claim_supersessions",
      "semantic_allocations",
    ];
    const counts = () =>
      tables.map(
        (table) =>
          s.db
            .query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
            .get()!.n,
      );
    const before = counts();
    const definition = definitionRef(s.card());
    const requires = relationOf(s.card(), "concept.requires")["claim"];
    const calls: CorrectArgs[] = [
      {
        statement: "Beliefs follow evidence.",
        target: { world_claim: definition },
        mode: "replace_object",
      },
      {
        statement: "Needs logic.",
        target: { world_claim: requires },
        mode: "replace_object",
        object: { kind: "node", ref: s.logic },
      },
      {
        statement: "Not so.",
        target: { world_claim: definition },
        mode: "retract",
      },
      {
        statement: "Only an idea.",
        target: { world_claim: definition },
        mode: "reclassify_mode",
        perspective_mode: "hypothetical",
      },
    ];
    for (const args of calls) {
      const done = await serveCorrect(s.kit.ctx, { ...args, dry_run: true });
      expect(done.data).toMatchObject({
        receipt_id: null,
        event_id: expect.any(String),
        claim_id: null,
        refreshedWorld: null,
      });
      expect(done.data!.answer).toStartWith("Would correct");
      expect(counts()).toEqual(before);
    }
  } finally {
    s.dispose();
  }
});

test("an agent that cannot relay the owner is refused before anything is recorded, in every mode", async () => {
  const s = await scene();
  try {
    const { token } = addAgent(s.db, "no-relay", {
      ...OWNER_AGENT_GRANT,
      relay_owner_corrections: false,
      tools: ["world_view", "correct"],
    });
    const agent = { ...s.kit.ctx, principal: authenticate(s.db, token)! };
    const card = s.kit.card(
      agent,
      "concept",
      s.kit.find(agent, "concept", "Bayesian"),
    );
    const claim = card["definitions"]?.[0]?.claim as ClaimRef | undefined;
    // Without the relay the agent cannot read the owner's corrections, but it reads the claim it targets.
    expect(claim).toBeDefined();
    for (const args of [
      { statement: "Beliefs follow evidence." },
      { statement: "Not so.", mode: "retract" as const },
      {
        statement: "Only an idea.",
        mode: "reclassify_mode" as const,
        perspective_mode: "suggested" as const,
      },
    ]) {
      await expect(
        serveCorrect(agent, { ...args, target: { world_claim: claim! } }),
      ).rejects.toThrow("relay is not granted");
    }
    expect(nativeEvidence(s)).toBe(0);
    expect(getClaim(s.db, s.definition)!.status).toBe("live");
  } finally {
    s.dispose();
  }
});

test("a relaying agent corrects, a node token from another principal is refused, and a second client reads the result", async () => {
  const s = await scene();
  try {
    const grant = {
      ...OWNER_AGENT_GRANT,
      ceiling: "private" as const,
      relay_owner_corrections: true,
      tools: ["world_view", "correct"] satisfies Tool[],
    };
    const relay = {
      ...s.kit.ctx,
      principal: authenticate(s.db, addAgent(s.db, "relay-a", grant).token)!,
    };
    const reader = {
      ...s.kit.ctx,
      principal: authenticate(s.db, addAgent(s.db, "reader-b", grant).token)!,
    };
    const card = s.kit.card(
      relay,
      "concept",
      s.kit.find(relay, "concept", "Bayesian"),
    );
    const edge = relationOf(card, "concept.requires");
    // The owner's token for another concept means nothing in the relay's own namespace.
    await expect(
      serveCorrect(relay, {
        statement: "Needs logic.",
        mode: "replace_object",
        object: { kind: "node", ref: s.logic },
        target: { world_claim: edge["claim"] },
      }),
    ).rejects.toThrow("names no node you can read");
    expect(nativeEvidence(s)).toBe(0);

    const own: WorldRef = s.kit.find(relay, "concept", "Formal logic");
    const done = await serveCorrect(relay, {
      statement: "Needs logic.",
      mode: "replace_object",
      object: { kind: "node", ref: own },
      target: { world_claim: edge["claim"] },
    });
    expect(done.data!.claim_id).toBeString();
    const seen = s.kit.card(
      reader,
      "concept",
      s.kit.find(reader, "concept", "Bayesian"),
    );
    const replaced = relationOf(seen, "concept.requires");
    expect(replaced["object"].kind).toBe("node");
    expect(replaced["object"].ref.token).toBe(
      s.kit.find(reader, "concept", "Formal logic").token,
    );
    expect(replaced["assessments"][0]).toMatchObject({
      authority: "owner_correction",
    });
  } finally {
    s.dispose();
  }
});

test("a retired claim takes no second correction, and a mode is part of a correction's identity", async () => {
  const s = await scene();
  try {
    const target = { world_claim: definitionRef(s.card()) };
    await serveCorrect(s.kit.ctx, { statement: "Not so.", mode: "retract", target });
    expect(nativeEvidence(s)).toBe(1);
    for (const args of [{ mode: "retract" as const }, { mode: "reclassify_mode" as const, perspective_mode: "suggested" as const }]) {
      await expect(serveCorrect(s.kit.ctx, { statement: "Not so.", target, ...args })).rejects.toThrow("names no live claim");
    }
    expect(nativeEvidence(s)).toBe(1);

    const claim = { claim_id: s.definition };
    const plain = sourceRecordId("Not so.", claim);
    expect(sourceRecordId("Not so.", claim, { mode: "replace_object" })).toBe(plain);
    expect(sourceRecordId("Not so.", claim, { mode: "retract" })).not.toBe(plain);
    expect(sourceRecordId("Not so.", claim, { mode: "reclassify_mode", to: "suggested" })).not.toBe(sourceRecordId("Not so.", claim, { mode: "retract" }));
    expect(sourceRecordId("Not so.", claim, { mode: "reclassify_mode", to: "questioned" })).not.toBe(
      sourceRecordId("Not so.", claim, { mode: "reclassify_mode", to: "suggested" }),
    );
    expect(sourceRecordId("Not so.", claim, { mode: "replace_object", object: { kind: "literal", value: "y" } })).not.toBe(plain);
  } finally {
    s.dispose();
  }
});

test("refresh_world returns the corrected card, and a refresh that fails leaves the committed correction standing", async () => {
  const s = await scene();
  try {
    const refresh = { operation: "concept" as const, concept: s.ref };
    const done = await serveCorrect(s.kit.ctx, {
      statement: "Update beliefs by Bayes' rule.",
      refresh_world: refresh,
      target: { world_claim: definitionRef(s.card()) },
    });
    const view = done.data!.refreshedWorld!;
    expect(worldData(view)["definitions"][0].object.value).toBe(
      "Update beliefs by Bayes' rule.",
    );

    // The committed correction needs a fresh claim reference for the refreshed card, which this trigger refuses to issue.
    const target = { world_claim: definitionRef(s.card()) };
    s.db.exec("CREATE TRIGGER refuse_claim_refs BEFORE INSERT ON world_wire_claim_targets BEGIN SELECT RAISE(ABORT, 'refresh refused'); END");
    const forced = await serveCorrect(s.kit.ctx, { statement: "Prior odds times likelihood.", refresh_world: refresh, target });
    expect(forced.data!.receipt_id).toBeString();
    expect(forced.data!.refreshedWorld).toEqual({
      schema: "kizuki.world-view/v1",
      operation: "concept",
      result: { status: "unavailable", reason: "storage" },
    });
    expect(getClaim(s.db, forced.data!.claim_id!)!.status).toBe("live");
  } finally {
    s.dispose();
  }
});

test("a malformed refresh is refused before the correction writes", async () => {
  const s = await scene();
  try {
    await expect(
      serveCorrect(s.kit.ctx, {
        statement: "Beliefs follow evidence.",
        refresh_world: {
          operation: "concept",
          concept: { kind: "object", token: "not-a-token" },
        },
        target: { world_claim: definitionRef(s.card()) },
      }),
    ).rejects.toThrow("refresh_world");
    expect(nativeEvidence(s)).toBe(0);
  } finally {
    s.dispose();
  }
});

test("modes and typed objects need a world claim, and each mode takes only its own arguments", async () => {
  const s = await scene();
  try {
    const target = { world_claim: definitionRef(s.card()) };
    for (const [args, message] of [
      [{ statement: "x", mode: "retract" }, "world_claim target"],
      [{ statement: "x", target, mode: "erase" }, "mode"],
      [
        {
          statement: "x",
          target,
          mode: "retract",
          object: { kind: "literal", value: "y" },
        },
        "only for mode replace_object",
      ],
      [{ statement: "x", target, mode: "reclassify_mode" }, "perspective_mode"],
      [
        { statement: "x", target, perspective_mode: "suggested" },
        "only for mode reclassify_mode",
      ],
      [
        {
          statement: "x",
          target,
          object: { kind: "literal", value: "y", extra: true },
        },
        "object",
      ],
    ] as const) {
      await expect(
        serveCorrect(s.kit.ctx, args as unknown as CorrectArgs),
      ).rejects.toThrow(message);
    }
    expect(nativeEvidence(s)).toBe(0);
  } finally {
    s.dispose();
  }
});

test("the loopback endpoint takes the same modes and refuses the same arguments", async () => {
  const s = await scene();
  const loopback = await startLoopback(s.db, s.vault.path);
  try {
    const read = await loopback.post("world_view", { operation: "concept", concept: s.ref, valid: { kind: "all" }, knownAt: { kind: "current" } });
    expect(read.status).toBe(200);
    const claim = (read.body as { value: { data: { result: { data: { definitions: { claim: ClaimRef }[] } } } } }).value.data.result.data.definitions[0]!.claim;
    const bad = await loopback.post("correct", { statement: "x", mode: "reclassify_mode", target: { world_claim: claim } });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(nativeEvidence(s)).toBe(0);
    const done = await loopback.post("correct", {
      statement: "That is not what it means.",
      mode: "retract",
      target: { world_claim: claim },
      refresh_world: { operation: "concept", concept: s.ref },
    });
    expect(done.status).toBe(200);
    const data = (done.body as { value: { data: Record<string, any> } }).value.data;
    expect(data["mode"]).toBe("retract");
    expect(data["refreshedWorld"].result.data.definitions[0]).toMatchObject({ polarity: "negative" });
  } finally {
    await loopback.stop();
    s.dispose();
  }
});
