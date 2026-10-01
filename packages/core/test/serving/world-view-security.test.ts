import { afterEach, beforeEach, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { OWNER, OWNER_AGENT_GRANT, addAgent, authenticate, revokeAgent, setGrant } from "../../src/agents";
import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import { semanticKey } from "../../src/claims/claim-v2-keys";
import { insertClaim } from "../../src/claims/store";
import { advanceCanonReadGeneration } from "../../src/canon/write-intent";
import { recordNativeCorrection } from "../../src/correction/evidence";
import { readWorldView, serveWorldView } from "@kizuki/core/world";
import { purgeEvents } from "../../src/ledger/purge";
import { inspectSourceGrant, revokeSourceGrant, setSourceGrant } from "../../src/ledger/source-grants";
import { assertNoninterference, hiddenScene, HIDDEN_MUTATIONS } from "../helpers/noninterference";
import type { NoninterferenceScene } from "../helpers/noninterference";
import { worldSeed } from "../helpers/world-seed";
import { validEvent } from "../fixtures";

setDefaultTimeout(120_000);
const scenes: NoninterferenceScene[] = [];
beforeEach(() => setSystemTime(new Date("2030-01-01T00:00:00.000Z")));
afterEach(() => { for (const made of scenes.splice(0)) made.dispose(); setSystemTime(); });
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
      const finish = (result: unknown) => {
        // Audit admission commits first. Only the projection returns a Served
        // body with `withheld`; nested savepoints must not trigger the race.
        if (!fired && !target.inTransaction && result !== null && typeof result === "object" && "withheld" in result) {
          fired = true; mutate();
        }
        return result;
      };
      return Object.assign(() => finish(transaction()), {
        immediate: () => finish(transaction.immediate()),
      });
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("unreadable resume handles preserve bytes, errors and work across hidden mutations", async () => {
  let completed = 0;
  await assertNoninterference({ mutations: HIDDEN_MUTATIONS, cases: (made) => {
    const shared = readWorldView({ ...made.reader, principal: OWNER }, {
      operation: "share", of: { operation: "concept", concept: made.hidden.ref }, ...WHEN,
    });
    if (!("result" in shared) || !("data" in shared.result) || shared.result.data.schema !== "kizuki.resume-handle/v1") throw new Error("no handle");
    const handle = shared.result.data.handle;
    return [{ name: "unreadable resume", run: (ctx) => {
      const value = serveWorldView(ctx, { operation: "resume", handle, ...WHEN });
      expect(value.data).toMatchObject({ result: REQUIRED });
      completed++;
      return value;
    } }];
  } });
  expect(completed).toBe(HIDDEN_MUTATIONS.length * 4);
});

test("resume rejects a claim outside the reader's type grant before projection, including after erasure", async () => {
  let completed = 0;
  await assertNoninterference({
    scene: async () => {
      const made = await hiddenScene();
      const agent = addAgent(made.db, "capture-only-reader", { ...OWNER_AGENT_GRANT, types: ["note"] });
      return { ...made, reader: { ...made.reader, principal: authenticate(made.db, agent.token)! } };
    },
    mutations: [{ name: "unreadable claim purge", apply: (made) => {
      purgeEvents(made.db, made.vaultPath, { event_id: made.visible.concept.eventId }, "synthetic-claim-purge");
    } }],
    cases: (made) => {
      const shared = readWorldView({ ...made.reader, principal: OWNER }, {
        operation: "share", of: { operation: "concept", concept: made.visible.concept.ref }, ...WHEN,
      });
      if (!("result" in shared) || !("data" in shared.result) || shared.result.data.schema !== "kizuki.resume-handle/v1") throw new Error("no handle");
      const handle = shared.result.data.handle;
      return [{ name: "claim-denied resume", run: (ctx) => {
        const value = serveWorldView(ctx, { operation: "resume", handle, ...WHEN });
        expect(value.data).toMatchObject({ result: REQUIRED });
        completed++;
        return value;
      } }];
    },
  });
  expect(completed).toBe(4);
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

async function duplicateLabelSupport(made: NoninterferenceScene) {
  const input = { operation: "find_concepts", label: "Bayesian updating", ...WHEN };
  const before = readWorldView(made.reader, input);
  if (!("result" in before) || before.result.status !== "current") throw new Error("no discovery");
  // Source-supplied endpoints are namespace-bound. Independent owner evidence
  // can attest the existing object through the shared native support writer.
  for (const claimId of made.visible.concept.claims.slice(0, 2)) {
    const semantic = readClaimV2Semantic(made.db, claimId);
    if (semantic?.discriminator !== "assertion") throw new Error("no assertion");
    const text = "Independent owner evidence for the existing concept.";
    const event = recordNativeCorrection(made.db, {
      ...validEvent(), connector_id: "kizuki.owner", source_record_id: `view-support-${claimId}`,
      text, sensitivity_hint: "public", subjects: [{ subject_id: semantic.subject.id, role: "about" }], metadata: { world_target: {
        claim_id: claimId, semantic_key: semanticKey(semantic), subject: semantic.subject, predicate: semantic.predicate,
      } },
    }, "a".repeat(64));
    const supported = { ...semantic, schema: "kizuki.claim/v2" as const,
      perspective: { ...semantic.perspective, anchors: [] },
      anchors: [{ event_id: event.event_id, start_utf16: 0, end_utf16: text.length }] };
    const stored = await insertClaim({ db: made.db }, {
      kind: "claim", body: text, provenance: [event.event_id], producer: "owner", intent: "correct",
      confidence: 1, sensitivity: "public", subjects: [semantic.subject.id], semantic: supported,
      events: [{ event_id: event.event_id, connector_id: "kizuki.owner", taint: "owner", text }],
      world_admission: { schema: "kizuki.world-admission/v1", semantic: supported,
        rendering: { body: text, frontmatter: {} }, authority: "owner_authored", confidence: 1, epistemicKind: "model_inference" },
    });
    expect(stored.outcome).toBe("duplicate");
    if (stored.outcome !== "duplicate") throw new Error("no independent support");
    expect(stored.claim.claim_id).toBe(claimId);
  }
  const after = readWorldView(made.reader, input);
  if (!("result" in after) || after.result.status !== "current") throw new Error("no surviving discovery");
  expect(after.result.data).toEqual(before.result.data);
}

function deniedDiscoveryBaseline(made: NoninterferenceScene) {
  const input = { operation: "find_concepts", label: "Bayesian updating", ...WHEN };
  const first = readWorldView(made.reader, input);
  if (!("result" in first) || first.result.status !== "current" || !("validUntil" in first.result)) throw new Error("no discovery baseline");
  revoke(made, made.visible.concept.sourceKey);
  const fresh = readWorldView(made.reader, input);
  if (!("result" in fresh) || fresh.result.status !== "current") throw new Error("no surviving projection");
  expect(fresh.result.data).toEqual(first.result.data);
  return { ...input, priorView: first.result.view };
}

test("baseline dependencies lose consent even when independent support preserves every projected byte", async () => {
  const made = await setup();
  await duplicateLabelSupport(made);
  const input = deniedDiscoveryBaseline(made);
  expect(serveWorldView(made.reader, input).data).toMatchObject({ result: REQUIRED });
});

test("hidden purge of revoked baseline evidence preserves conditional bytes, errors and work", async () => {
  let completed = 0;
  await assertNoninterference({
    scene: async () => {
      const made = await hiddenScene();
      await duplicateLabelSupport(made);
      return made;
    },
    mutations: [{ name: "revoked support purge", apply: (made) => {
      purgeEvents(made.db, made.vaultPath, { event_id: made.visible.concept.eventId }, "synthetic-revoked-support-purge");
    } }],
    cases: (made) => {
      const input = deniedDiscoveryBaseline(made);
      return [{ name: "denied discovery baseline", run: (ctx) => {
        const value = serveWorldView(ctx, input);
        expect(value.data).toMatchObject({ result: REQUIRED });
        completed++;
        return value;
      } }];
    },
  });
  expect(completed).toBe(4);
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
  let completed = 0, revoked = 0;
  await assertNoninterference({
    mutations: [{ name: "hidden source revoke after snapshot", apply: (made) => { armed.add(made); } }],
    cases: (made) => {
      const priorView = baseline(made);
      return [{ name: "audited conditional read", run: (ctx) => {
        const db = afterSnapshot(ctx.db, () => { if (armed.has(made)) { revoke(made, made.hidden.sourceKey); revoked++; } });
        const value = serveWorldView({ ...ctx, db }, { ...concept(made), priorView });
        expect(value.data).toMatchObject({ result: { status: "unchanged", view: priorView } });
        completed++;
        return value;
      } }];
    },
  });
  expect(completed).toBe(4);
  expect(revoked).toBe(1);
});

test("hidden purge after projection preserves conditional bytes, errors and work at the audited seam", async () => {
  const armed = new WeakSet<NoninterferenceScene>();
  let completed = 0, purged = 0;
  await assertNoninterference({
    mutations: [{ name: "hidden purge after snapshot", apply: (made) => { armed.add(made); } }],
    cases: (made) => {
      const priorView = baseline(made);
      return [{ name: "audited conditional read", run: (ctx) => {
        const db = afterSnapshot(ctx.db, () => {
          if (armed.has(made)) {
            purgeEvents(made.db, made.vaultPath, { event_id: made.hidden.eventId }, "synthetic-hidden-race-purge");
            purged++;
          }
        });
        const value = serveWorldView({ ...ctx, db }, { ...concept(made), priorView });
        expect(value.data).toMatchObject({ result: { status: "unchanged", view: priorView } });
        completed++;
        return value;
      } }];
    },
  });
  expect(completed).toBe(4);
  expect(purged).toBe(1);
});

test("visible purge after projection discards conditional data and the retained baseline", async () => {
  const made = await setup(), priorView = baseline(made);
  const db = afterSnapshot(made.db, () => {
    purgeEvents(made.db, made.vaultPath, { event_id: made.visible.concept.eventId }, "synthetic-visible-race-purge");
  });
  expect(serveWorldView({ ...made.reader, db }, { ...concept(made), priorView }).data).toMatchObject({ result: REQUIRED });
  expect(readWorldView(made.reader, { ...concept(made), priorView })).toMatchObject({ result: REQUIRED });
});

test("unrelated canon publication after projection preserves conditional bytes, errors and work", async () => {
  const armed = new WeakSet<NoninterferenceScene>();
  let advanced = 0;
  await assertNoninterference({
    mutations: [{ name: "unrelated canon generation after snapshot", apply: (made) => { armed.add(made); } }],
    cases: (made) => {
      const priorView = baseline(made);
      return [{ name: "audited conditional read", run: (ctx) => {
        const db = afterSnapshot(ctx.db, () => {
          if (armed.has(made)) {
            made.db.transaction(() => advanceCanonReadGeneration(made.db)).immediate();
            advanced++;
          }
        });
        const value = serveWorldView({ ...ctx, db }, { ...concept(made), priorView });
        expect(value.data).toMatchObject({ result: { status: "unchanged", view: priorView } });
        return value;
      } }];
    },
  });
  expect(advanced).toBe(1);
});

test.each(["erased", "expired", "revoked", "quarantined"])("resume %s after projection returns uniform invalidation", async (cause) => {
  const made = await setup();
  const shared = readWorldView(made.reader, {
    operation: "share", of: { operation: "concept", concept: made.refs.concept }, ...WHEN,
  });
  if (!("result" in shared) || !("data" in shared.result) || shared.result.data.schema !== "kizuki.resume-handle/v1") throw new Error("no handle");
  const owner = { ...made.reader, principal: OWNER };
  const db = afterSnapshot(made.db, () => {
    if (cause === "erased") made.db.query("DELETE FROM world_resume_handles").run();
    if (cause === "expired") setSystemTime(new Date("2030-01-02T00:00:00.000Z"));
    if (cause === "revoked") revokeAgent(made.db, "narrow-reader");
    if (cause === "quarantined") made.db.query("UPDATE agents SET quarantined_at=? WHERE name='narrow-reader'").run(new Date().toISOString());
  });
  const input = { operation: "resume", handle: shared.result.data.handle, ...WHEN };
  const value = serveWorldView({ ...owner, db }, input).data;
  expect(value).toMatchObject({ result: REQUIRED });
  expect(value).toEqual(readWorldView(owner, { ...input, handle: "A".repeat(43) }));
  expect(readWorldView(owner, input)).toEqual(value);
  expect(JSON.stringify(value)).not.toContain("Bayesian updating");
});

function incompleteSource(made: NoninterferenceScene, sourceKey: string) {
  const result = JSON.stringify({ stored: 1, duplicates: 0, errors: [], proposals_created: 0, withdrawn: 0, retractions_filed: 0, cursor: null });
  made.db.query(`INSERT INTO checkpoints(connector_id,source_key,cursor,mode,updated_at,last_run_at,last_result,backfill_complete)
    VALUES ('world.fixture',?,NULL,'backfill',?,?,?,0)`).run(sourceKey, new Date().toISOString(), new Date().toISOString(), result);
}

test("coverage-only source revocation after projection removes its gap before the conditional answer", async () => {
  const made = await setup(), priorView = baseline(made);
  incompleteSource(made, made.visible.situation.sourceKey);
  const db = afterSnapshot(made.db, () => revoke(made, made.visible.situation.sourceKey));
  const input = { ...concept(made), priorView };
  const value = serveWorldView({ ...made.reader, db }, input).data;
  expect(value).toMatchObject({ result: { status: "unchanged", view: priorView } });
  expect(value).toEqual(readWorldView(made.reader, input));
});

test("coverage becomes partial after projection and cannot return unchanged", async () => {
  const made = await setup(), priorView = baseline(made);
  const db = afterSnapshot(made.db, () => incompleteSource(made, made.visible.situation.sourceKey));
  const input = { ...concept(made), priorView };
  const value = serveWorldView({ ...made.reader, db }, input).data;
  expect(value).toMatchObject({ result: { status: "incomplete", reasons: ["coverage"] } });
  expect(value).toEqual(readWorldView(made.reader, input));
});

test("coverage-only purge after projection removes the purged source's gap", async () => {
  const made = await setup(), priorView = baseline(made);
  incompleteSource(made, made.visible.situation.sourceKey);
  const db = afterSnapshot(made.db, () => {
    purgeEvents(made.db, made.vaultPath, { event_id: made.visible.situation.eventId }, "synthetic-coverage-race-purge");
  });
  const input = { ...concept(made), priorView };
  const value = serveWorldView({ ...made.reader, db }, input).data;
  expect(value).toMatchObject({ result: { status: "unchanged", view: priorView } });
  expect(value).toEqual(readWorldView(made.reader, input));
});

test("newly extract-granted backlog after projection makes the conditional answer incomplete", async () => {
  const made = await setup(), priorView = baseline(made);
  const grant = inspectSourceGrant(made.db, made.visible.situation.sourceKey)!;
  const db = afterSnapshot(made.db, () => setSourceGrant(made.db, {
    source_key: grant.source_key, expected_revision: grant.revision, operation_id: "view-extraction-backlog",
    policy: { ...grant.policy, purposes: [...grant.policy.purposes, "extract"] },
  }));
  const input = { ...concept(made), priorView };
  const value = serveWorldView({ ...made.reader, db }, input).data;
  expect(value).toMatchObject({ result: { status: "incomplete", reasons: ["pending_consolidation"] } });
  expect(value).toEqual(readWorldView(made.reader, input));
});

test("hidden checkpoint after projection preserves conditional bytes, errors and work", async () => {
  const armed = new WeakSet<NoninterferenceScene>();
  let changed = 0;
  await assertNoninterference({
    mutations: [{ name: "hidden checkpoint after snapshot", apply: (made) => { armed.add(made); } }],
    cases: (made) => {
      const priorView = baseline(made);
      return [{ name: "audited conditional read", run: (ctx) => {
        const db = afterSnapshot(ctx.db, () => {
          if (armed.has(made)) { incompleteSource(made, made.hidden.sourceKey); changed++; }
        });
        const value = serveWorldView({ ...ctx, db }, { ...concept(made), priorView });
        expect(value.data).toMatchObject({ result: { status: "unchanged", view: priorView } });
        return value;
      } }];
    },
  });
  expect(changed).toBe(1);
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

test("source revalidation preserves the request purpose when recall remains authorized", async () => {
  const made = await setup(), priorView = baseline(made);
  const input = { ...concept(made), priorView };
  const ctx = { ...made.reader, sourcePurpose: "derive" as const };
  expect(readWorldView(ctx, input)).toMatchObject({ result: { status: "unchanged" } });
  const grant = inspectSourceGrant(made.db, made.visible.concept.sourceKey)!;
  const db = afterSnapshot(made.db, () => setSourceGrant(made.db, {
    source_key: grant.source_key, expected_revision: grant.revision, operation_id: "view-purpose-withdrawal",
    policy: { ...grant.policy, purposes: grant.policy.purposes.filter((purpose) => purpose !== "derive") },
  }));
  expect(serveWorldView({ ...ctx, db }, input).data).toMatchObject({ result: REQUIRED });
  expect(readWorldView(ctx, concept(made))).toEqual({ status: "not_found" });
  expect(readWorldView(made.reader, concept(made))).toMatchObject({ result: { status: "current" } });
});
