import { afterEach, beforeEach, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { readWorldView, serveWorldView } from "@kizuki/core/world";
import { collectReadFrames, withWorldPipeline } from "@kizuki/core/testing";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import type { ServeContext } from "../../src/serving/types";
import type { Grouper } from "../../src/world/pipeline/group";
import { canonicalBytes, checkNoninterference, HIDDEN_MUTATIONS, type ReadCase } from "../helpers/noninterference";
import { worldSeed } from "../helpers/world-seed";
import { validateConceptCard, type ConceptCard } from "../../src/contracts/concept-card";

setDefaultTimeout(120_000);
beforeEach(() => setSystemTime(new Date("2030-01-01T00:00:00.000Z")));
afterEach(() => setSystemTime());

const view = (label: string, cursor?: string) => ({
  operation: "find_concepts", label, ...(cursor === undefined ? {} : { cursor }),
  valid: { kind: "all" }, knownAt: { kind: "current" },
});

function page(ctx: ServeContext, label = "", cursor?: string) {
  const result = readWorldView(ctx, view(label, cursor));
  if (!("result" in result) || result.result.status === "unavailable" || !("matches" in result.result.data))
    throw new Error("discovery unavailable");
  return result.result.data;
}

const handleOf = (db: ReturnType<typeof openLedger>, subject: string): string =>
  db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?")
    .get(subject)!.handle_id;

const joinHandles = (members: readonly string[]): Grouper => (_frame, cluster) =>
  members.includes(cluster.anchor)
    ? { ...cluster, members, resolution: "resolved" }
    : cluster;

test("discovery joins aliases once, filters their combined labels and serves the same grouped card", async () => {
  const db = openLedger(":memory:");
  try {
    const first = await worldSeed(db, { subject: "topic:first", label: "First label" });
    await worldSeed(db, { subject: "topic:alias", label: "Alias label" });
    const members = [handleOf(db, "topic:first"), handleOf(db, "topic:alias")].sort();
    expect(page(first.ctx).matches).toHaveLength(2);
    withWorldPipeline({ groupers: [joinHandles(members)] }, () => {
      const all = page(first.ctx);
      expect(all.matches).toHaveLength(1);
      expect(all.matches[0]!.labels).toEqual(expect.arrayContaining(["First label", "Alias label"]));
      expect(page(first.ctx, "Alias").matches).toEqual(all.matches);
      expect(page(first.ctx, "absent").matches).toEqual([]);
      const card = readWorldView(first.ctx, {
        operation: "concept", concept: all.matches[0]!.ref,
        valid: { kind: "all" }, knownAt: { kind: "current" },
      });
      if (!("result" in card) || card.result.status === "unavailable") throw new Error("card unavailable");
      expect((card.result.data as ConceptCard).concept.labels.map((label) => label.text).sort())
        .toEqual(["Alias label", "First label"]);
    });
    expect(page(first.ctx).matches).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("a saturated alias cannot crowd the requested anchor out of its grouped card", async () => {
  const db = openLedger(":memory:");
  try {
    await worldSeed(db, {
      subject: "topic:full-alias", label: "Full alias",
      predicates: Array.from({ length: 128 }, (_, index) => ({
        predicate: "concept.example",
        object: { kind: "literal" as const, value: `Example ${index}` },
      })),
    });
    const requested = await worldSeed(db, { subject: "topic:requested", label: "Requested concept" });
    const members = [handleOf(db, "topic:full-alias"), handleOf(db, "topic:requested")];
    const read = () => readWorldView(requested.ctx, {
      operation: "concept", concept: requested.ref,
      valid: { kind: "all" }, knownAt: { kind: "current" },
    });
    expect(read()).toMatchObject({ result: { status: "current" } });
    const grouped = withWorldPipeline({ groupers: [joinHandles(members)] }, read);
    expect(grouped).toMatchObject({
      result: { status: "incomplete", reasons: ["traversal_limit"] },
    });
    if (!("result" in grouped) || grouped.result.status === "unavailable")
      throw new Error("grouped card unavailable");
    const card = grouped.result.data as ConceptCard;
    expect(validateConceptCard(card).ok).toBe(true);
    expect(card.concept.ref).toEqual(requested.ref!);
    expect(card.concept.classificationClaims).toHaveLength(1);
    expect(card.concept.labels.map((label) => label.text)).toContain("Requested concept");
    expect(card.coverage).toMatchObject({ status: "partial", gaps: ["traversal_limit"] });
    const reversed = withWorldPipeline({ groupers: [joinHandles([...members].reverse())] }, read);
    expect(reversed).toEqual(grouped);
  } finally {
    db.close();
  }
});

test("grouped discovery paginates without duplicates or lost aliases", async () => {
  const db = openLedger(":memory:");
  try {
    const first = await worldSeed(db, { subject: "topic:first", label: "First label" });
    await worldSeed(db, { subject: "topic:alias", label: "Alias label" });
    for (let i = 0; i < 33; i += 1)
      await worldSeed(db, { subject: `topic:page-${i}`, label: `Page ${i}`, discover: false });
    const members = [handleOf(db, "topic:first"), handleOf(db, "topic:alias")];
    withWorldPipeline({ groupers: [joinHandles(members)] }, () => {
      const one = page(first.ctx);
      expect(one.matches).toHaveLength(32);
      expect(one.cursor).not.toBeNull();
      const two = page(first.ctx, "", one.cursor!);
      expect(two.matches).toHaveLength(2);
      expect(two.cursor).toBeNull();
      const matches = [...one.matches, ...two.matches];
      expect(new Set(matches.map((match) => match.ref.token)).size).toBe(34);
      expect(matches.flatMap((match) => match.labels)).toHaveLength(35);
    });
  } finally {
    db.close();
  }
});

test("discovery prunes unauthorized group members before labels, representatives and counters", async () => {
  const db = openLedger(":memory:");
  try {
    const first = await worldSeed(db, { subject: "topic:first", label: "First label" });
    await worldSeed(db, { subject: "topic:hidden", label: "Hidden alias", floor: "private" });
    const agent = addAgent(db, "group-reader", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["topic:first"] });
    const ctx = { ...first.ctx, principal: authenticate(db, agent.token)! };
    const handles = [handleOf(db, "topic:first"), handleOf(db, "topic:hidden")];
    withWorldPipeline({ groupers: [joinHandles(handles)] }, () => {
      expect(page(ctx).matches.map((match) => match.labels)).toEqual([["First label"]]);
      expect(page(ctx, "Hidden").matches).toEqual([]);
      expect(page(first.ctx).matches[0]!.labels).toEqual(expect.arrayContaining(["First label", "Hidden alias"]));
    });
  } finally {
    db.close();
  }
});

test("grouped discovery passes the F3 hidden-claim, revoke, identity and purge checks", async () => {
  const leaks = await checkNoninterference({
    mutations: HIDDEN_MUTATIONS.filter((mutation) =>
      ["hidden claim", "hidden source revoke", "hidden identity merge", "hidden purge"].includes(mutation.name)),
    cases: (scene) => {
      const handles = [handleOf(scene.db, "topic:bayes"), handleOf(scene.db, "topic:hidden")];
      return ["", "Bayesian", "priors"].map((label): ReadCase => {
        let stats = { rowsExamined: 0, claimsVerified: 0 };
        return {
          name: `grouped discovery ${label}`,
          run: (ctx) => withWorldPipeline({ groupers: [joinHandles(handles)] }, () => {
            const read = collectReadFrames(() => serveWorldView(ctx, view(label)));
            stats = read.frames[0]!.stats;
            return read.result;
          }),
          stats: () => stats,
        };
      });
    },
  });
  expect(leaks).toEqual([]);
});

test("group size is bounded after authorization and an oversized visible group returns budget", async () => {
  const db = openLedger(":memory:");
  try {
    const first = await worldSeed(db, { subject: "topic:first", label: "First label" });
    const anchor = handleOf(db, "topic:first");
    const invisible = Array.from({ length: 140 }, (_, index) => `unallocated-${index}`);
    const read = (members: readonly string[]) => withWorldPipeline({ groupers: [joinHandles(members)] }, () =>
      collectReadFrames(() => readWorldView(first.ctx, view(""))),
    );
    const before = read([anchor]);
    const hidden = read([anchor, ...invisible]);
    expect(canonicalBytes(hidden.result)).toEqual(canonicalBytes(before.result));
    expect(hidden.frames[0]!.stats).toEqual(before.frames[0]!.stats);
    for (let i = 0; i < 128; i += 1)
      await worldSeed(db, { subject: `topic:bounded-${i}`, label: `Bounded ${i}`, discover: false });
    const members = db.query<{ handle_id: string }, []>("SELECT handle_id FROM semantic_bindings").all()
      .map((row) => row.handle_id);
    expect(read(members).result).toEqual({
      schema: "kizuki.world-view/v1", operation: "find_concepts",
      result: { status: "unavailable", reason: "budget" },
    });
    expect(page(first.ctx).matches).toHaveLength(32);
  } finally {
    db.close();
  }
});
