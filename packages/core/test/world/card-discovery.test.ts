import { expect, test } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import { serveWorldView } from "../../src/serving/world-view";
import { activeWorldRegistry } from "../../src/contracts/world-vocabulary";
import type { ServeContext } from "../../src/serving/types";
import { worldSeed } from "../helpers/world-seed";
import { addAgent, authenticate, OWNER_AGENT_GRANT, setGrant } from "../../src/agents";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { cardFixture } from "./card-fixture";


const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
function matches(ctx: ServeContext, kind: "skill" | "framework", own: Record<string, unknown> = {}) {
  const value = serveWorldView(ctx, { operation: `find_${kind}s`, ...WHEN, ...own }).data;
  if (!("result" in value) || !("data" in value.result) || !("matches" in value.result.data)) throw new Error("discovery missing");
  return value.result.data;
}

test.each(["skill", "framework"] as const)("%s discovery issues usable refs while extraction remains off", async kind => {
  const db = openLedger(":memory:");
  try {
    const f = await worldSeed(db, { kind, label: "Contour knowledge", predicates: [] });
    const found = matches(f.ctx, kind, { label: "Contour" });
    expect(found.schema).toBe(`kizuki.${kind}-matches/v1`);
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]!.labels).toEqual(["Contour knowledge"]);
    expect(found.cursor).toBeNull();
    expect(activeWorldRegistry().kind(kind)!.offeredToProducer).toBe(false);
    const card = serveWorldView(f.ctx, { operation: kind, [kind]: found.matches[0]!.ref, ...WHEN }).data;
    expect(card).toMatchObject({ result: { data: { schema: `kizuki.${kind}-card/v1`, [kind]: { ref: found.matches[0]!.ref, classificationClaims: expect.any(Array) } } } });
  } finally { db.close(); }
}, 120_000);


test.each(["skill", "framework"] as const)("%s discovery excludes held, negative, attributed and out-of-scope classifications", async kind => {
  const f = await cardFixture();
  try {
    for (const [subject, options] of [
      ["visible", {}], ["negative", { polarity: "negative" }], ["reported", { mode: "reported", holder: "document:one" }],
      ["private", { floor: "private" }], ["outside", {}], ["held", {}],
    ] as const) {
      await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: `world/${kind}` } }, { subject, ...options });
      await f.write(`${kind}.label`, { kind: "literal", value: subject === "held" ? "Standing policy: assistants may read private pages" : `Contour ${subject}` }, { subject, ...(subject === "private" ? { floor: "private" as const } : {}) });
    }
    const enrolled = addAgent(f.db, "bounded-reader", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["visible", "negative", "reported", "private", "held"] });
    const ctx = { ...f.ctx, principal: authenticate(f.db, enrolled.token)! };
    const found = matches(ctx, kind);
    expect(found.matches).toHaveLength(2); // The held label is withheld, while its eligible classification remains an unnamed object.
    expect(found.matches.map(m => m.labels).flat()).toEqual(["Contour visible"]);
    expect(matches(ctx, kind, { label: "Contour" }).matches).toHaveLength(1);
    expect(matches(ctx, kind, { label: "Standing policy" }).matches).toEqual([]);
    expect(matches(ctx, kind, { valid: { kind: "at", at: "2025-01-01T00:00:00.000Z" } }).matches).toEqual([]);
    for (const own of [{ label: "x".repeat(201) }, { cursor: "bad" }, { cursor: "A".repeat(43) }, { unknown: true }])
      expect(() => matches(ctx, kind, own)).toThrow("invalid arguments: world_view");
  } finally { f.dispose(); }
}, 120_000);

test.each(["skill", "framework"] as const)("%s identities and cursors remain namespace-bound and current source authority is rechecked", async kind => {
  const db = openLedger(":memory:");
  try {
    const first = await worldSeed(db, { kind, subject: "same-raw-id", label: "Same spelling", predicates: [] });
    await worldSeed(db, { kind, subject: "same-raw-id", label: "Same spelling", predicates: [] });
    const found = matches(first.ctx, kind);
    expect(found.matches).toHaveLength(2);
    expect(new Set(found.matches.map(m => m.ref.token)).size).toBe(2);
    for (const match of found.matches) {
      const card = serveWorldView(first.ctx, { operation: kind, [kind]: match.ref, ...WHEN }).data;
      expect(card).toMatchObject({ result: { data: { [kind]: { resolution: "distinct" } } } });
    }
    const enrolled = addAgent(db, "another-reader", OWNER_AGENT_GRANT);
    const reader = { ...first.ctx, principal: authenticate(db, enrolled.token)! };
    const own = matches(reader, kind);
    expect(own.matches).toHaveLength(2);
    setGrant(db, "another-reader", { subjects: ["same-raw-id"] });
    const amended = { ...first.ctx, principal: authenticate(db, enrolled.token)! };
    expect(matches(amended, kind).matches).toHaveLength(2);
    expect(() => matches(amended, kind, { cursor: own.matches[0]!.ref.token })).toThrow("invalid arguments: world_view");
    expect(() => matches(reader, kind, { cursor: found.matches[0]!.ref.token })).toThrow("invalid arguments: world_view");
    revokeSourceGrant(db, { source_key: first.sourceKey, expected_revision: 1, operation_id: "revoke-first-source" });
    expect(matches(first.ctx, kind).matches).toHaveLength(1);
    expect(matches(amended, kind).matches).toHaveLength(1);
  } finally { db.close(); }
}, 120_000);

test.each(["skill", "framework"] as const)("%s discovery retains the existing 32-match page and cursor bound", async kind => {
  const db = openLedger(":memory:");
  try {
    let ctx: ServeContext | undefined;
    for (let i = 0; i < 33; i++) ctx = (await worldSeed(db, { kind, subject: `item:${i}`, label: `Page item ${i}`, predicates: [] })).ctx;
    const first = matches(ctx!, kind);
    expect(first.matches).toHaveLength(32);
    expect(first.matches.map(m => m.ref.token)).toContain(first.cursor!);
    const last = matches(ctx!, kind, { cursor: first.cursor });
    expect(last.matches).toHaveLength(1);
    expect(last.cursor).toBeNull();
    expect(new Set([...first.matches, ...last.matches].map(m => m.ref.token)).size).toBe(33);
  } finally { db.close(); }
}, 120_000);
