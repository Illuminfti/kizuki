import { expect, test } from "bun:test";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { cardFixture } from "./card-fixture";
import { observe } from "../helpers/noninterference";
import { openLedger } from "../../src/ledger/db";
import { worldFixture } from "../serving/world-fixture";
import { worldSeed } from "../helpers/world-seed";
import { readWorldView } from "@kizuki/core/world";

test("overlapping definitions and opposite polarities mark both claims conflicting", async () => {
  const f = await cardFixture();
  try {
    await f.write("concept.definition", { kind: "literal", value: "Keep prior beliefs unchanged" });
    expect(f.card().definitions.map((r) => r.conflict)).toEqual(["present", "present"]);
    await f.write("concept.example", { kind: "literal", value: "An observation" });
    await f.write("concept.example", { kind: "literal", value: "An observation" }, { polarity: "negative" });
    expect(f.card().relations.filter((r) => r.predicate === "concept.example").map((r) => r.conflict)).toEqual(["present", "present"]);
  } finally { f.dispose(); }
});

test("nonoverlapping definitions have no observed conflict; incomplete source coverage stays unknown", async () => {
  const f = await cardFixture();
  try {
    await f.write("concept.definition", { kind: "literal", value: "An earlier formulation" }, { from: "2025-01-01T00:00:00Z", until: "2026-01-01T00:00:00Z" });
    expect(f.card().definitions.map((r) => r.conflict)).toEqual(["none_observed", "none_observed"]);
    setSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "enable-extraction", policy: {
      purposes: ["capture", "derive", "recall", "correction", "export", "extract"], allowed_fields: ["text", "subjects", "metadata", "attachments"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public",
    } });
    expect(f.card().coverage.gaps).toContain("pending_consolidation");
    expect(f.card().definitions.map((r) => r.conflict)).toEqual(["unknown", "unknown"]);
  } finally { f.dispose(); }
});

test("a private conflicting definition changes neither narrow card bytes nor visible conflict", async () => {
  const f = await cardFixture();
  try {
    const agent = addAgent(f.db, "card-reader", { ...OWNER_AGENT_GRANT, ceiling: "public" });
    const reader = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    f.card(reader);
    const read = { name: "card", run: (ctx: typeof reader) => f.card(ctx) };
    const before = await observe(reader, read);
    await f.write("concept.definition", { kind: "literal", value: "A private contradiction" }, { floor: "private" });
    expect(await observe(reader, read)).toEqual(before);
    expect(f.card().definitions.every((r) => r.conflict === "present")).toBe(true);
  } finally { f.dispose(); }
});

test("assistance joins the exact learning task and retains opposing qualified evidence", async () => {
  const f = await cardFixture();
  try {
    await f.write("learning.application", { kind: "subject", ref: f.ref("topic:bayes") }, { subject: "person:ada", context: ["task:one"] });
    await f.write("learning.exposure", { kind: "subject", ref: f.ref("topic:bayes") }, { subject: "person:ada", context: ["task:two"] });
    await f.write("learning.assistance", { kind: "vocabulary", ref: { kind: "vocabulary", id: "learning/assisted" } }, { subject: "task:one", context: ["person:ada"] });
    let card = f.card();
    expect(card.learning.find((l) => l.facet === "application")?.assistance).toBe("assisted");
    expect(card.learning.find((l) => l.facet === "application")?.assistanceEvidence).toHaveLength(1);
    expect(card.learning.find((l) => l.facet === "exposure")?.assistance).toBe("unknown");
    expect(card.learning.some((l) => l.facet === "demonstration")).toBe(false);
    await f.write("learning.assistance", { kind: "vocabulary", ref: { kind: "vocabulary", id: "learning/unassisted" } }, { subject: "task:one", context: ["person:ada"] });
    card = f.card();
    const application = card.learning.find((l) => l.facet === "application")!;
    expect(application.assistance).toBe("unknown");
    expect(application.assistanceEvidence).toHaveLength(2);
    expect(application.assistanceEvidence.every((r) => r.conflict === "present")).toBe(true);
  } finally { f.dispose(); }
});

test("recorded forwards and copies cannot be independent, original support can", async () => {
  const f = await cardFixture();
  try {
    expect(f.card().definitions[0]!.assessments[0]!.independence).toBe("independent");
    await f.write("concept.example", { kind: "literal", value: "A forwarded example" }, { metadata: { forward_from: { id: "sender:other" } } });
    await f.write("concept.counterexample", { kind: "literal", value: "A copied example" }, { metadata: { copied_from: "record:other" } });
    expect(f.card().relations.map((r) => r.assessments[0]!.independence)).toEqual(["dependent", "dependent"]);
  } finally { f.dispose(); }
});

test("repeated exact text adds no independent support and unknown lineage stays unknown", async () => {
  const f = await cardFixture();
  try {
    await f.write("concept.definition", { kind: "literal", value: "Revise beliefs using evidence" }, { text: f.definition.event.text });
    const assessments = f.card().definitions[0]!.assessments;
    expect(assessments).toHaveLength(2);
    expect(assessments.filter((a) => a.independence === "independent")).toHaveLength(0);
    expect(assessments.filter((a) => a.independence === "dependent")).toHaveLength(2);
    await f.write("concept.example", { kind: "literal", value: "Unresolved derivation" }, { metadata: { lineage: { status: "unknown" } } });
    expect(f.card().relations[0]!.assessments[0]!.independence).toBe("unknown");
  } finally { f.dispose(); }
});

test("assistance for another actor, another task or a disjoint valid window cannot qualify this application", async () => {
  const f = await cardFixture();
  try {
    await f.write("learning.application", { kind: "subject", ref: f.ref("topic:bayes") }, { subject: "person:ada", context: ["task:one"] });
    const assistance = (value: string) => ({ kind: "vocabulary" as const, ref: { kind: "vocabulary" as const, id: value } });
    await f.write("learning.assistance", assistance("learning/assisted"), { subject: "task:one", context: ["person:ada"] });
    await f.write("learning.assistance", assistance("learning/unassisted"), { subject: "task:one", context: ["person:ben"] });
    await f.write("learning.assistance", assistance("learning/unassisted"), { subject: "task:two", context: ["person:ada"] });
    await f.write("learning.assistance", assistance("learning/unassisted"), { subject: "task:one", context: ["person:ada"], from: "2025-01-01T00:00:00Z", until: "2026-01-01T00:00:00Z" });
    const application = f.card().learning[0]!;
    expect(application.assistance).toBe("assisted");
    expect(application.assistanceEvidence).toHaveLength(1);
    expect(application.assistanceEvidence[0]!.conflict).toBe("none_observed");
  } finally { f.dispose(); }
});

test("a speaker does not become the actor in another learner's assistance claim", async () => {
  const f = await cardFixture();
  try {
    await f.write("learning.exposure", { kind: "subject", ref: f.ref("topic:bayes") }, { subject: "person:learner", context: ["task:shared"] });
    await f.write("learning.assistance", { kind: "vocabulary", ref: { kind: "vocabulary", id: "learning/assisted" } }, {
      subject: "task:shared", context: ["person:other"], speaker: "person:learner",
    });
    const learning = f.card().learning;
    expect(learning).toHaveLength(1);
    expect(learning[0]!.assistance).toBe("unknown");
    expect(learning[0]!.assistanceEvidence).toEqual([]);
  } finally { f.dispose(); }
});

test("several stated Situation blockers are uncertain slots, not contradictory facts", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db, { kind: "situation", subject: "project:launch", label: "Launch" });
    await worldSeed(db, { sourceKey: f.sourceKey, kind: "situation", subject: "project:launch", label: "Launch", predicates: [
      { predicate: "situation.blocker", object: { kind: "literal", value: "Pending materials" } },
      { predicate: "situation.blocker", object: { kind: "literal", value: "Pending scheduling" } },
    ] });
    const result = readWorldView(f.ctx, { operation: "situation", situation: f.ref, valid: { kind: "all" }, knownAt: { kind: "current" } });
    if (!("result" in result) || result.result.status === "unavailable" || result.result.data.schema !== "kizuki.situation-card/v1") throw new Error("situation unavailable");
    expect(result.result.data.blocker).toBeNull();
    expect(result.result.data.uncertainty.filter((r) => r.predicate === "situation.blocker").map((r) => r.conflict)).toEqual(["none_observed", "none_observed"]);
  } finally { db.close(); }
});
