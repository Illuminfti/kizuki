import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openLedger } from "../../src/ledger/db";
import { readWorldView, serveWorldView } from "../../src/serving/world-view";
import { assertWorldState } from "../../src/world/integrity";
import { testClock } from "../helpers/clock";
import { WorldSeedError, worldSeed } from "../helpers/world-seed";
import { worldFixture } from "./world-fixture";

/** What a seed stores, minus the random ids and wall-clock stamps. */
function stored(db: Database) {
  return {
    claims: db
      .query<Record<string, unknown>, []>(
        `SELECT predicate, object, polarity, body, sensitivity, subject, status, producer
         FROM claims ORDER BY predicate`,
      )
      .all(),
    events: db.query<Record<string, unknown>, []>("SELECT text, kind, connector_id FROM events ORDER BY text").all(),
  };
}

/** Wire tokens are random per ledger; number them by first appearance so two ledgers compare. */
function canonicalTokens(json: string): string {
  const seen = new Map<string, number>();
  return json.replace(/[A-Za-z0-9_-]{43}/g, (token) => `<ref${seen.set(token, seen.get(token) ?? seen.size).get(token)}>`);
}

const lookup = (ref: { kind: "object"; token: string }, operation: "concept" | "situation") => ({
  operation,
  [operation]: ref,
  valid: { kind: "all" },
  knownAt: { kind: "current" },
});

test("worldSeed stores what worldFixture stores for a concept and for a situation", async () => {
  for (const kind of ["concept", "situation"] as const) {
    const a = openLedger(":memory:"),
      b = openLedger(":memory:");
    try {
      const options = kind === "concept" ? {} : { subject: "project:launch", label: "Launch" };
      const fixture = await worldFixture(a, { kind, ...options });
      const seed = await worldSeed(b, { kind, ...options });
      expect(stored(b)).toEqual(stored(a));
      expect(seed.claims).toHaveLength(fixture.claims.length);
      expect(seed.ref).not.toBeNull();
      const card = (ctx: typeof fixture.ctx, ref: { kind: "object"; token: string }) =>
        canonicalTokens(JSON.stringify(serveWorldView(ctx, lookup(ref, kind)).data));
      expect(card(seed.ctx, seed.ref!)).toBe(card(fixture.ctx, fixture.ref));
      assertWorldState(b);
    } finally {
      a.close();
      b.close();
    }
  }
});

test("a predicate list alone decides what a kind stores", async () => {
  const db = openLedger(":memory:");
  try {
    const seed = await worldSeed(db, {
      kind: "situation",
      subject: "project:launch",
      label: "Launch",
      predicates: [
        { predicate: "situation.objective", object: { kind: "literal", value: "Ship the beta" } },
        { predicate: "situation.blocker", object: { kind: "literal", value: "Waiting on review" } },
      ],
    });
    expect(seed.claims).toHaveLength(4);
    const card = JSON.stringify(readWorldView(seed.ctx, lookup(seed.ref!, "situation")));
    expect(card).toContain("Ship the beta");
    expect(card).toContain("Waiting on review");
    expect(card).not.toContain("Revise beliefs");
  } finally {
    db.close();
  }
});

test("a new kind is seeded from its predicates or refused whole, never half seeded", async () => {
  const db = openLedger(":memory:");
  try {
    const outcome = await worldSeed(db, { kind: "question", label: "What is idempotency?" }).then(
      (seed) => seed,
      (error: unknown) => error,
    );
    const count = () => db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!.n;
    if (outcome instanceof WorldSeedError) {
      expect(outcome.message).toContain("world.kind");
      expect(count()).toBe(0);
    } else {
      const seed = outcome as Awaited<ReturnType<typeof worldSeed>>;
      expect(seed.claims).toHaveLength(2);
      expect(count()).toBe(2);
      expect(seed.ref).toBeNull();
    }
  } finally {
    db.close();
  }
});

test("discovery can be switched off for a kind that has a discovery operation", async () => {
  const db = openLedger(":memory:");
  try {
    expect((await worldSeed(db, { discover: false })).ref).toBeNull();
  } finally {
    db.close();
  }
});

test("the test clock fixes asserted_at without a sleep", async () => {
  const db = openLedger(":memory:");
  try {
    const clock = testClock("2026-03-01T09:00:00.000Z");
    await worldSeed(db, { clock });
    clock.advance(90_000);
    await worldSeed(db, { clock, subject: "topic:other", label: "Other idea" });
    const times = db
      .query<{ asserted_at: string }, []>("SELECT DISTINCT asserted_at FROM claims ORDER BY asserted_at")
      .all()
      .map((row) => row.asserted_at);
    expect(times).toEqual(["2026-03-01T09:00:00.000Z", "2026-03-01T09:01:30.000Z"]);
    expect(() => clock.set("2026-03-01T09:00:00.000Z")).toThrow(RangeError);
    expect(clock.set("2026-03-02T00:00:00.000Z")).toBe("2026-03-02T00:00:00.000Z");
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => testClock("not a time")).toThrow(RangeError);
  } finally {
    db.close();
  }
});
