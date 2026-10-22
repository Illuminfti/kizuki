import { expect, test } from "bun:test";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import type { ConceptCard } from "../../src/contracts/concept-card";
import type { SituationCard } from "../../src/contracts/situation-card";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { readWorldView } from "../../src/serving/world-view";
import type { ServeContext } from "../../src/serving/types";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { cardFixture } from "./card-fixture";

const FROM = "2026-02-01T00:00:00.000Z";
const INSIDE = "2026-03-01T00:00:00.000Z";
const UNTIL = "2026-04-01T00:00:00.000Z";
const AFTER = "2026-05-01T00:00:00.000Z";
const knownAt = { kind: "current" } as const;
const literal = (value: string) => ({ kind: "literal" as const, value });

function find(
  ctx: ServeContext,
  operation: "find_concepts" | "find_situations",
  label: string,
  valid: { kind: "all" } | { kind: "at"; at: string } = { kind: "all" },
) {
  const result = readWorldView(ctx, { operation, label, valid, knownAt });
  if (!("result" in result) || result.result.status === "unavailable" || !("matches" in result.result.data))
    throw new Error("synthetic discovery unavailable");
  return result.result.data;
}

function concept(ctx: ServeContext, ref: { kind: "object"; token: string }, at: string): ConceptCard {
  const result = readWorldView(ctx, { operation: "concept", concept: ref, valid: { kind: "at", at }, knownAt });
  if (!("result" in result) || result.result.status === "unavailable" || result.result.data.schema !== "kizuki.concept-card/v1")
    throw new Error("synthetic concept unavailable");
  return result.result.data;
}

test("qualified Concept labels are time-bounded search aliases, not display-label promotion", async () => {
  const f = await cardFixture();
  try {
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } }, {
      subject: "topic:azure",
    });
    await f.write("concept.label", literal("Azure practice"), { subject: "topic:azure" });
    const before = collectReadFrames(() => find(f.ctx, "find_concepts", ""));
    await f.write("concept.label", literal("Archive calculus"), {
      mode: "reported", holder: "document:handbook", from: FROM, until: UNTIL,
      text: "The handbook calls this practice Archive calculus.",
    });
    await f.write("concept.label", literal("Ledger arithmetic"), {
      mode: "reported", speaker: "person:curator", from: FROM, until: UNTIL,
      text: "The curator calls this practice Ledger arithmetic.",
    });
    const after = collectReadFrames(() => find(f.ctx, "find_concepts", ""));
    expect(after.result.matches).toEqual(before.result.matches);
    expect(after.frames.map(frame => frame.stats)).toEqual(before.frames.map(frame => frame.stats));

    const match = find(f.ctx, "find_concepts", "Archive", { kind: "at", at: INSIDE });
    expect(match.matches).toHaveLength(1);
    expect(match.matches[0]!.labels).toEqual(["Bayesian updating"]);
    expect(find(f.ctx, "find_concepts", "Archive", { kind: "at", at: FROM }).matches).toHaveLength(1);
    expect(find(f.ctx, "find_concepts", "Ledger arithmetic", { kind: "at", at: INSIDE }).matches).toHaveLength(1);
    expect(find(f.ctx, "find_concepts", "Archive", { kind: "at", at: UNTIL }).matches).toEqual([]);
    expect(find(f.ctx, "find_concepts", "Archive", { kind: "at", at: AFTER }).matches).toEqual([]);

    const card = concept(f.ctx, match.matches[0]!.ref, INSIDE);
    expect(card.concept.labels.map(label => label.text)).toEqual(["Bayesian updating"]);
    const aliases = card.relations.filter(relation => relation.predicate === "concept.label");
    expect(aliases).toHaveLength(2);
    expect(aliases.map(relation => relation.object)).toContainEqual(literal("Archive calculus"));
    expect(aliases.map(relation => relation.object)).toContainEqual(literal("Ledger arithmetic"));
    const archive = aliases.find(relation => relation.object.kind === "literal" && relation.object.value === "Archive calculus")!;
    expect(archive).toMatchObject({
      claim: { kind: "claim", token: expect.any(String) },
      perspective: { mode: "reported", interpretation: "explicit", holder: { kind: "object" }, speaker: null },
      valid: { kind: "known", from: FROM, until: UNTIL }, temporalBasis: "explicit",
    });
    expect(archive.perspective.evidence).not.toHaveLength(0);
    expect(archive.assessments[0]!.evidence).not.toHaveLength(0);
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } }, {
      subject: "topic:reported-only", mode: "reported", holder: "document:index", from: FROM, until: UNTIL,
    });
    await f.write("concept.label", literal("Index-only concept"), {
      subject: "topic:reported-only", mode: "reported", holder: "document:index", from: FROM, until: UNTIL,
    });
    expect(find(f.ctx, "find_concepts", "Index-only", { kind: "at", at: INSIDE }).matches).toEqual([]);
  } finally { f.dispose(); }
});

test("qualified Situation labels search through speakers and remain uncertainty", async () => {
  const f = await cardFixture();
  try {
    const subject = "project:handoff";
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }, { subject });
    await f.write("situation.label", literal("Direct handoff"), { subject });
    await f.write("situation.label", literal("West handoff"), {
      subject, mode: "reported", speaker: "person:operator", from: FROM, until: UNTIL,
      text: "The operator calls this situation West handoff.",
    });
    const found = find(f.ctx, "find_situations", "West handoff", { kind: "at", at: INSIDE });
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]!.labels).toEqual(["Direct handoff"]);
    const result = readWorldView(f.ctx, { operation: "situation", situation: found.matches[0]!.ref,
      valid: { kind: "at", at: INSIDE }, knownAt });
    if (!("result" in result) || result.result.status === "unavailable" || result.result.data.schema !== "kizuki.situation-card/v1")
      throw new Error("synthetic situation unavailable");
    const card = result.result.data as SituationCard;
    expect(card.situation.labels.map(label => label.text)).toEqual(["Direct handoff"]);
    expect(card.uncertainty).toContainEqual(expect.objectContaining({ predicate: "situation.label",
      object: literal("West handoff"), perspective: expect.objectContaining({ mode: "reported",
        speaker: expect.objectContaining({ kind: "object" }) }) }));
  } finally { f.dispose(); }
});

test("unattributed, non-reported, inferred, and negative labels are not search aliases", async () => {
  const f = await cardFixture();
  try {
    await f.write("concept.label", literal("Unattributed alias"), { mode: "reported", from: FROM, until: UNTIL });
    await f.write("concept.label", literal("Quoted alias"), { mode: "quoted", holder: "document:note", from: FROM, until: UNTIL });
    await f.write("concept.label", literal("Inferred alias"), { mode: "reported", interpretation: "inferred",
      holder: "document:note", from: FROM, until: UNTIL });
    await f.write("concept.label", literal("Negative alias"), { mode: "reported", holder: "document:note",
      polarity: "negative", from: FROM, until: UNTIL });
    for (const label of ["Unattributed", "Quoted", "Inferred", "Negative"])
      expect(find(f.ctx, "find_concepts", label, { kind: "at", at: INSIDE }).matches).toEqual([]);
  } finally { f.dispose(); }
});

for (const loss of ["revoke", "purge"] as const) test(`${loss} withholds a qualified label alias`, async () => {
  const f = await cardFixture();
  try {
    const alias = await f.write("concept.label", literal("Revocable alias"), {
      mode: "reported", holder: "document:register", from: FROM, until: UNTIL,
    });
    expect(find(f.ctx, "find_concepts", "Revocable", { kind: "at", at: INSIDE }).matches).toHaveLength(1);
    if (loss === "revoke") revokeSourceGrant(f.db, {
      source_key: f.sourceKey, expected_revision: 1, operation_id: "revoke-qualified-label-source",
    });
    else purgeEvents(f.db, f.ctx.vaultPath, { event_id: alias.event.event_id }, "erase synthetic qualified label");
    expect(find(f.ctx, "find_concepts", "Revocable", { kind: "at", at: INSIDE }).matches).toEqual([]);
  } finally { f.dispose(); }
});

test("a denied qualified alias changes neither empty discovery nor query results", async () => {
  const f = await cardFixture();
  try {
    const agent = addAgent(f.db, "public-alias-reader", { ...OWNER_AGENT_GRANT, ceiling: "public" });
    const reader = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const before = collectReadFrames(() => find(reader, "find_concepts", ""));
    await f.write("concept.label", literal("Private register alias"), {
      mode: "reported", holder: "document:private-register", floor: "private", from: FROM, until: UNTIL,
    });
    const after = collectReadFrames(() => find(reader, "find_concepts", ""));
    expect(after.result.matches).toEqual(before.result.matches);
    expect(after.frames.map(frame => frame.stats)).toEqual(before.frames.map(frame => frame.stats));
    expect(find(reader, "find_concepts", "Private register", { kind: "at", at: INSIDE }).matches).toEqual([]);
    expect(find(f.ctx, "find_concepts", "Private register", { kind: "at", at: INSIDE }).matches).toHaveLength(1);
  } finally { f.dispose(); }
});

test("query-only aliases cannot displace asserted display labels at the candidate bound", async () => {
  const f = await cardFixture();
  try {
    await f.write("concept.label", literal("Bounded search alias"), {
      mode: "reported", holder: "document:register", from: FROM, until: UNTIL,
    });
    for (let index = 0; index < 126; index += 1)
      await f.write("concept.label", literal(`Display label ${index.toString().padStart(3, "0")}`));
    const empty = find(f.ctx, "find_concepts", "", { kind: "at", at: INSIDE });
    const queried = find(f.ctx, "find_concepts", "Bounded search alias", { kind: "at", at: INSIDE });
    expect(empty.matches).toHaveLength(1);
    expect(empty.matches[0]!.labels).toHaveLength(127);
    expect(queried.matches[0]!.labels).toEqual(empty.matches[0]!.labels);
  } finally { f.dispose(); }
});

test("an alias overflow refuses instead of reporting an exhaustive query miss", async () => {
  const f = await cardFixture();
  try {
    const aliases: { claimId: string; label: string }[] = [];
    for (let index = 0; index < 129; index += 1) {
      const label = `Overflow alias ${index.toString().padStart(3, "0")}`;
      const written = await f.write("concept.label", literal(label), {
        mode: "reported", holder: "document:register", from: FROM, until: UNTIL,
      });
      if (!("claim" in written.stored)) throw new Error("synthetic alias was not stored");
      aliases.push({ claimId: written.stored.claim.claim_id, label });
    }
    const last = aliases.sort((left, right) => left.claimId.localeCompare(right.claimId)).at(-1)!;
    expect(readWorldView(f.ctx, { operation: "find_concepts", label: last.label,
      valid: { kind: "at", at: INSIDE }, knownAt })).toEqual({
      schema: "kizuki.world-view/v1", operation: "find_concepts",
      result: { status: "unavailable", reason: "budget" },
    });
  } finally { f.dispose(); }
});
