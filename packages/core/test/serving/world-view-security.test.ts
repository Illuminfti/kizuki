import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { OWNER, setGrant } from "../../src/agents";
import { readWorldView, serveWorldView } from "@kizuki/core/world";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { assertNoninterference, hiddenScene, HIDDEN_MUTATIONS } from "../helpers/noninterference";
import type { NoninterferenceScene } from "../helpers/noninterference";
import { worldSeed } from "../helpers/world-seed";

setDefaultTimeout(120_000);
const scenes: NoninterferenceScene[] = [];
afterEach(() => { for (const made of scenes.splice(0)) made.dispose(); });
const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const REQUIRED = { status: "new_view_required" } as const;
const concept = (made: NoninterferenceScene) => ({ operation: "concept", concept: made.refs.concept, ...WHEN });
function baseline(made: NoninterferenceScene) {
  const first = readWorldView(made.reader, concept(made));
  if (!("result" in first) || first.result.status !== "current" || !("validUntil" in first.result)) throw new Error("no baseline");
  return first.result.view;
}
async function setup() {
  const made = await hiddenScene(); scenes.push(made); return made;
}
function revoke(made: NoninterferenceScene, sourceKey: string) {
  revokeSourceGrant(made.db, { source_key: sourceKey, expected_revision: 1, operation_id: "view-consent-revoke" });
}

/** Inject once after the read snapshot commits, before the audited gate's final check. */
function afterSnapshot(db: Database, mutate: () => void): Database {
  let fired = false;
  return new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === "transaction") return (run: () => unknown) => {
      const transaction = target.transaction(run);
      return new Proxy(transaction, { get(inner, method) {
        if (method === "immediate") return () => {
          const result = inner.immediate();
          if (!fired && !target.inTransaction) { fired = true; mutate(); }
          return result;
        };
        return Reflect.get(inner, method, inner);
      } });
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("unreadable resume handles preserve bytes, errors and work across hidden mutations", async () => {
  await assertNoninterference({ mutations: HIDDEN_MUTATIONS, cases: (made) => {
    const shared = readWorldView({ ...made.reader, principal: OWNER }, {
      operation: "share", of: { operation: "concept", concept: made.hidden.ref }, ...WHEN,
    });
    if (!("result" in shared) || !("data" in shared.result) || shared.result.data.schema !== "kizuki.resume-handle/v1") throw new Error("no handle");
    const handle = shared.result.data.handle;
    return [{ name: "unreadable resume", run: (ctx) => {
      const value = serveWorldView(ctx, { operation: "resume", handle, ...WHEN });
      expect(value.data).toMatchObject({ result: REQUIRED });
      return value;
    } }];
  } });
});

test("source consent denial invalidates a conditional baseline uniformly and preserves fresh not_found", async () => {
  const made = await setup(), priorView = baseline(made);
  revoke(made, made.visible.concept.sourceKey);
  const denied = readWorldView(made.reader, { ...concept(made), priorView });
  const unknown = readWorldView(made.reader, { ...concept(made), priorView: { kind: "view", token: "A".repeat(43) } });
  expect(denied).toEqual(unknown);
  expect(denied).toMatchObject({ result: REQUIRED });
  expect(readWorldView(made.reader, concept(made))).toEqual({ status: "not_found" });
});

test("purge erases discovery label payload and dependencies while independent evidence keeps the object alive", async () => {
  const made = await setup();
  await worldSeed(made.db, {
    sourceKey: made.visible.concept.sourceKey, subject: "topic:bayes", label: "Independent survivor", discover: false,
  });
  const input = { operation: "find_concepts", label: "Bayesian updating", ...WHEN };
  const first = readWorldView(made.reader, input);
  if (!("result" in first) || first.result.status !== "current" || !("validUntil" in first.result)) throw new Error("no discovery baseline");
  expect(JSON.stringify(first.result.data)).toContain("Bayesian updating");
  purgeEvents(made.db, made.vaultPath, { event_id: made.visible.concept.eventId }, "synthetic-label-purge");
  expect(readWorldView(made.reader, { ...input, priorView: first.result.view })).toMatchObject({ result: REQUIRED });
  const retained = made.db.query<{ projection: Uint8Array }, []>("SELECT projection FROM world_view_tokens").all();
  expect(retained.some((row) => Buffer.from(row.projection).toString().includes("Bayesian updating"))).toBe(false);
  expect(made.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(readWorldView(made.reader, concept(made))).toMatchObject({ result: { status: "current", data: { concept: { labels: [{ text: "Independent survivor" }] } } } });
});

test("hidden consent revoked after projection preserves conditional bytes, errors and work at the audited seam", async () => {
  const armed = new WeakSet<NoninterferenceScene>();
  await assertNoninterference({
    mutations: [{ name: "hidden source revoke after snapshot", apply: (made) => { armed.add(made); } }],
    cases: (made) => {
      const priorView = baseline(made);
      return [{ name: "audited conditional read", run: (ctx) => {
        const db = afterSnapshot(ctx.db, () => { if (armed.has(made)) revoke(made, made.hidden.sourceKey); });
        const value = serveWorldView({ ...ctx, db }, { ...concept(made), priorView });
        expect(value.data).toMatchObject({ result: { status: "unchanged", view: priorView } });
        return value;
      } }];
    },
  });
});

test("visible consent revoked after projection prevents stale data and unchanged at the audited seam", async () => {
  const made = await setup(), priorView = baseline(made);
  const db = afterSnapshot(made.db, () => revoke(made, made.visible.concept.sourceKey));
  const value = serveWorldView({ ...made.reader, db }, { ...concept(made), priorView });
  expect(value.data).toMatchObject({ result: REQUIRED });
  expect(JSON.stringify(value)).not.toContain("Bayesian updating");
  expect(made.db.query("SELECT denied FROM agent_audit WHERE tool='world_view' ORDER BY at DESC LIMIT 1").get()).toEqual({ denied: "[]" });
});

test("a fresh read reprojects once after visible consent denial without retaining the discarded token", async () => {
  const made = await setup();
  const tokens = () => made.db.query("SELECT token_hash FROM world_view_tokens ORDER BY token_hash").all();
  const before = tokens();
  const db = afterSnapshot(made.db, () => revoke(made, made.visible.concept.sourceKey));
  expect(serveWorldView({ ...made.reader, db }, concept(made)).data).toEqual({ status: "not_found" });
  expect(tokens()).toEqual(before);
});

test("a grant narrowed after projection invalidates the baseline under current authority", async () => {
  const made = await setup(), priorView = baseline(made);
  const db = afterSnapshot(made.db, () => setGrant(made.db, "narrow-reader", { subjects: [] }));
  expect(serveWorldView({ ...made.reader, db }, { ...concept(made), priorView }).data).toMatchObject({ result: REQUIRED });
});
