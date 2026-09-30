/**
 * Discovery must not call a kind complete when nothing can populate it. A kind
 * that is registered, reachable only by extraction, and not offered to the
 * extraction model has no claims by design; an empty page for it is partial
 * with the gap `coverage`, never `complete_for_query`.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import { OWNER, OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { createWorldRegistry, type WorldVocabularyModule } from "../../src/contracts/world-kinds";
import { WORLD_VOCABULARY_MODULES, withWorldRegistry } from "../../src/contracts/world-vocabulary";
import { openLedger } from "../../src/ledger/db";
import { serveWorldView } from "@kizuki/core/world";
import type { ServeContext } from "../../src/serving/types";
import { collectReadFrames } from "@kizuki/core/testing";
import { testClock } from "../helpers/clock";
import { worldSeed } from "../helpers/world-seed";

setDefaultTimeout(120_000);

/** The shipped vocabulary with one kind switched off for the extraction model. */
function withoutProducer(id: string): ReturnType<typeof createWorldRegistry> {
  const modules: WorldVocabularyModule[] = WORLD_VOCABULARY_MODULES.map((module) =>
    module.kind?.id === id ? { ...module, kind: { ...module.kind, offeredToProducer: false } } : module,
  );
  return createWorldRegistry(modules);
}

const ownerCtx = (db: ReturnType<typeof openLedger>): ServeContext => ({ db, vaultPath: "/tmp/world-population", principal: OWNER });

function find(ctx: ServeContext, operation: "find_concepts" | "find_situations", label: string) {
  const { data } = serveWorldView(ctx, { operation, label, valid: { kind: "all" }, knownAt: { kind: "current" } });
  if (!("result" in data) || data.result.status === "unavailable") throw new Error("discovery unavailable");
  const page = data.result.data as unknown as { matches: unknown[]; coverage: { status: string; gaps: string[] } };
  return { status: data.result.status, matches: page.matches.length, coverage: page.coverage };
}

test("an empty page for a kind nothing can populate is partial with the gap coverage", () => {
  const db = openLedger(":memory:");
  try {
    const ctx = ownerCtx(db);
    expect(find(ctx, "find_situations", "")).toMatchObject({
      status: "current",
      matches: 0,
      coverage: { status: "complete_for_query", gaps: [] },
    });
    const dark = withWorldRegistry(withoutProducer("situation"), () => find(ctx, "find_situations", ""));
    expect(dark.status).toBe("incomplete");
    expect(dark.matches).toBe(0);
    expect(dark.coverage.status).toBe("partial");
    expect(dark.coverage.gaps).toEqual(["coverage"]);
    const offered = withWorldRegistry(withoutProducer("situation"), () => find(ctx, "find_concepts", ""));
    expect(offered.status).toBe("current");
    expect(offered.coverage.gaps).toEqual([]);
  } finally {
    db.close();
  }
});

test("a kind that has claims is not called dark, whatever the label filter leaves", async () => {
  const db = openLedger(":memory:");
  try {
    const ctx = ownerCtx(db);
    await worldSeed(db, { kind: "situation", subject: "project:launch", label: "Launch plan", discover: false });
    withWorldRegistry(withoutProducer("situation"), () => {
      expect(find(ctx, "find_situations", "Launch")).toMatchObject({ status: "current", matches: 1 });
      expect(find(ctx, "find_situations", "zzzz")).toMatchObject({
        status: "current",
        matches: 0,
        coverage: { status: "complete_for_query", gaps: [] },
      });
    });
  } finally {
    db.close();
  }
});

test("a kind hidden from the reader by its grant reads as empty, not as populated", async () => {
  const db = openLedger(":memory:");
  try {
    await worldSeed(db, { kind: "situation", subject: "project:secret", label: "Secret plan", floor: "private", discover: false });
    const agent = addAgent(db, "narrow", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["project:other"] });
    const principal = authenticate(db, agent.token);
    if (principal === null) throw new Error("the narrow reader did not authenticate");
    const dark = withWorldRegistry(withoutProducer("situation"), () =>
      find({ db, vaultPath: "/tmp/world-population", principal }, "find_situations", ""),
    );
    expect(dark).toMatchObject({ status: "incomplete", matches: 0, coverage: { status: "partial", gaps: ["coverage"] } });
  } finally {
    db.close();
  }
});

test("a scanned classification with invalid support does not populate a dark kind", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db, { kind: "situation", discover: false });
    db.query("UPDATE claim_v2_support SET admission=json_set(admission,'$.semantic.polarity','negative') WHERE claim_id=?")
      .run(seed.claims[0]!);
    const result = withWorldRegistry(withoutProducer("situation"), () => find(ownerCtx(db), "find_situations", ""));
    expect(result).toMatchObject({ status: "incomplete", matches: 0, coverage: { status: "partial", gaps: ["coverage"] } });
  } finally {
    db.close();
  }
});

for (const restriction of [
  { name: "claim type", grant: { types: ["note"] }, asserted: "2026-02-28T10:30:00Z" },
  { name: "asserted since", grant: { since: "2026-02-28T10:30:00Z" }, asserted: "2026-01-01T00:00:00Z" },
  { name: "asserted until", grant: { until: "2026-02-28T10:30:00Z" }, asserted: "2026-04-01T00:00:00Z" },
]) {
  for (const kind of ["concept", "situation"] as const) {
    test(`${kind} denied by ${restriction.name} cannot populate a dark kind or move work counters`, async () => {
      const db = openLedger(":memory:");
      try {
        const agent = addAgent(db, "restricted-reader", { ...OWNER_AGENT_GRANT, ...restriction.grant });
        const principal = authenticate(db, agent.token)!;
        const ctx = { ...ownerCtx(db), principal };
        const read = (label: string) => collectReadFrames(() =>
          withWorldRegistry(withoutProducer(kind), () => find(ctx, `find_${kind}s`, label)),
        );
        const before = read("");
        const seed = await worldSeed(db, {
          kind, subject: "topic:restricted", label: "Restricted label",
          clock: testClock(restriction.asserted), discover: false,
        });
        for (const label of ["", "Restricted", "absent"]) {
          const after = read(label);
          expect(after.result).toEqual(before.result);
          expect(after.frames.map((frame) => frame.stats)).toEqual([{ rowsExamined: 0, claimsVerified: 0 }]);
        }
        db.query("UPDATE claims SET status='reverted' WHERE claim_id IN (SELECT value FROM json_each(?))")
          .run(JSON.stringify(seed.claims));
        const reverted = read("");
        expect(reverted.result).toEqual(before.result);
        expect(reverted.frames.map((frame) => frame.stats)).toEqual(before.frames.map((frame) => frame.stats));
      } finally {
        db.close();
      }
    });
  }
}

test("asserted-time bounds are inclusive and denied labels cannot consume candidate limits", async () => {
  const db = openLedger(":memory:");
  try {
    const at = "2026-02-28T10:30:00Z";
    const seed = await worldSeed(db, {
      label: "Visible label", clock: testClock(at), discover: false,
      predicates: Array.from({ length: 140 }, (_, index) => ({
        predicate: "concept.label", object: { kind: "literal" as const, value: `Denied label ${index}` },
      })),
    });
    const denied = JSON.stringify(seed.claims.slice(2));
    db.query("UPDATE claims SET asserted_at='2026-01-01T00:00:00Z',status='reverted' WHERE claim_id IN (SELECT value FROM json_each(?))")
      .run(denied);
    const agent = addAgent(db, "bounded-reader", {
      ...OWNER_AGENT_GRANT, types: ["note", "claim"], since: at, until: at,
    });
    const ctx = { ...ownerCtx(db), principal: authenticate(db, agent.token)! };
    const read = () => collectReadFrames(() => find(ctx, "find_concepts", "Visible"));
    const before = read();
    expect(before.result).toMatchObject({ status: "current", matches: 1, coverage: { gaps: [] } });
    db.query("UPDATE claims SET status='live' WHERE claim_id IN (SELECT value FROM json_each(?))").run(denied);
    const after = read();
    expect(after.result).toEqual(before.result);
    expect(after.frames[0]!.stats).toEqual(before.frames[0]!.stats);
  } finally {
    db.close();
  }
});
