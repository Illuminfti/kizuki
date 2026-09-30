import { afterEach, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { OWNER, addAgent, authenticate, OWNER_AGENT_GRANT, setGrant } from "../../src/agents";
import { readWorldView } from "@kizuki/core/world";
import type { ServeContext } from "../../src/serving/types";
import { hiddenScene, assertNoninterference, HIDDEN_MUTATIONS } from "../helpers/noninterference";
import { correct } from "../../src/correction/correct";
import { purgeEvents } from "../../src/ledger/purge";
import type { NoninterferenceScene } from "../helpers/noninterference";
import { worldSeed } from "../helpers/world-seed";

// Each scene builds a real ledger, so bound the tests for a loaded host.
setDefaultTimeout(120_000);

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

const scenes: NoninterferenceScene[] = [];
afterEach(() => {
  for (const scene of scenes.splice(0)) scene.dispose();
});

async function scene(): Promise<{
  scene: NoninterferenceScene;
  owner: ServeContext;
}> {
  const made = await hiddenScene();
  scenes.push(made);
  return {
    scene: made,
    owner: { db: made.db, vaultPath: made.vaultPath, principal: OWNER },
  };
}

const concept = (
  ref: { kind: "object"; token: string },
  extra: Record<string, unknown> = {},
) => ({
  operation: "concept",
  concept: ref,
  valid: { kind: "all" },
  knownAt: { kind: "current" },
  ...extra,
});

type Read = ReturnType<typeof readWorldView>;
const resultOf = (read: Read) => {
  if (!("result" in read)) throw new Error("the read found nothing");
  return read.result;
};

describe("view tokens on world_view", () => {
  test("agent creation reserves a partition, and grant amendment can reserve a freed slot", async () => {
    const { scene: made } = await scene();
    const read = () => resultOf(readWorldView(made.reader, concept(made.refs.concept)));
    expect(read()).toMatchObject({ status: "current", view: { kind: "view" } });
    made.db.query("DELETE FROM world_view_partitions WHERE principal_id=?").run(
      made.reader.principal.kind === "agent" ? made.reader.principal.agent.agent_id : "owner",
    );
    setGrant(made.db, "narrow-reader", {});
    const found = readWorldView(made.reader, { operation: "find_concepts", label: "Bayesian", valid: { kind: "all" }, knownAt: { kind: "current" } });
    if (!("result" in found) || !("data" in found.result) || !("matches" in found.result.data)) throw new Error("no discovery");
    expect(resultOf(readWorldView(made.reader, concept(found.result.data.matches[0]!.ref)))).toMatchObject({ status: "current", view: { kind: "view" } });
  });

  test("share and resume reproject for a second principal and disclose only clipped coverage", async () => {
    const { scene: made, owner } = await scene();
    const share = resultOf(readWorldView(owner, {
      operation: "share", of: { operation: "concept", concept: made.visible.concept.ref },
      valid: { kind: "all" }, knownAt: { kind: "current" },
    }));
    if (!("data" in share) || !("handle" in share.data)) throw new Error("no handle");
    expect(share.data.handle).toMatch(TOKEN);
    const resumed = resultOf(readWorldView(made.reader, {
      operation: "resume", handle: share.data.handle, valid: { kind: "all" }, knownAt: { kind: "current" },
    }));
    expect(resumed).toMatchObject({ status: "incomplete", reasons: ["coverage"], data: { concept: { ref: made.refs.concept }, coverage: { status: "partial", gaps: ["coverage"] } } });
    const peer = addAgent(made.db, "wide-peer", OWNER_AGENT_GRANT);
    const principal = authenticate(made.db, peer.token)!;
    const full = resultOf(readWorldView({ ...owner, principal }, {
      operation: "resume", handle: share.data.handle, valid: { kind: "all" }, knownAt: { kind: "current" },
    }));
    expect(full).toMatchObject({ status: "current", view: { kind: "view" } });
  });
  test("a reserved principal reading a Concept gets a random 43-character view token and its lifetime", async () => {
    const { scene: made, owner } = await scene();
    const before = Date.now();
    const result = resultOf(
      readWorldView(owner, concept(made.visible.concept.ref!)),
    );
    if (result.status !== "current" || !("validUntil" in result))
      throw new Error(`no view was issued: ${JSON.stringify(result)}`);
    expect(result.view.kind).toBe("view");
    expect(result.view.token).toMatch(TOKEN);
    expect(Date.parse(result.validUntil) - before).toBeGreaterThan(
      FIFTEEN_MINUTES - 5_000,
    );
    expect(Date.parse(result.validUntil) - Date.now()).toBeLessThanOrEqual(
      FIFTEEN_MINUTES,
    );
    const again = resultOf(
      readWorldView(owner, concept(made.visible.concept.ref!)),
    );
    if (again.status !== "current" || !("validUntil" in again))
      throw new Error("no second view was issued");
    expect(again.view.token).not.toBe(result.view.token);
  });

  test("a re-read with the prior view and no visible change is unchanged: the same token and no data", async () => {
    const { scene: made, owner } = await scene();
    const first = resultOf(
      readWorldView(owner, concept(made.visible.concept.ref!)),
    );
    if (first.status !== "current" || !("validUntil" in first))
      throw new Error("no view was issued");
    const second = resultOf(
      readWorldView(
        owner,
        concept(made.visible.concept.ref!, { priorView: first.view }),
      ),
    );
    expect(second).toEqual({
      status: "unchanged",
      view: first.view,
      validUntil: first.validUntil,
    });
  });

  test("a visible change returns a current view with a fresh token", async () => {
    const { scene: made, owner } = await scene();
    const first = resultOf(
      readWorldView(owner, concept(made.visible.concept.ref!)),
    );
    if (first.status !== "current" || !("validUntil" in first))
      throw new Error("no view was issued");
    await worldSeed(made.db, {
      sourceKey: made.visible.concept.sourceKey,
      subject: "topic:bayes",
      label: "Bayesian updating",
      predicates: [
        {
          predicate: "concept.definition",
          object: { kind: "literal", value: "A visible rewording" },
        },
      ],
      discover: false,
    });
    const second = resultOf(
      readWorldView(
        owner,
        concept(made.visible.concept.ref!, { priorView: first.view }),
      ),
    );
    if (second.status !== "current" || !("validUntil" in second))
      throw new Error(`expected a fresh view: ${JSON.stringify(second)}`);
    expect(second.view.token).toMatch(TOKEN);
    expect(second.view.token).not.toBe(first.view.token);
    expect(JSON.stringify(second.data)).toContain("A visible rewording");
  });

  test("a principal with no reserved partition still gets correct reads, marked not_issued", async () => {
    const { scene: made } = await scene();
    if (made.reader.principal.kind !== "agent") throw new Error("expected agent");
    made.db.query("DELETE FROM world_view_partitions WHERE principal_id=?").run(made.reader.principal.agent.agent_id);
    const result = resultOf(
      readWorldView(made.reader, concept(made.refs.concept)),
    );
    expect(result.status).toBe("current");
    expect("view" in result ? result.view : null).toEqual({
      status: "not_issued",
    });
    expect(
      "data" in result ? (result.data as { schema: string }).schema : null,
    ).toBe("kizuki.concept-card/v1");
  });

  test("a prior view nobody issued is new_view_required, with no data and no reason", async () => {
    const { scene: made, owner } = await scene();
    const stranger = { kind: "view", token: "A".repeat(43) };
    expect(
      resultOf(
        readWorldView(
          owner,
          concept(made.visible.concept.ref!, { priorView: stranger }),
        ),
      ),
    ).toEqual({
      status: "new_view_required",
    });
    expect(
      resultOf(
        readWorldView(
          made.reader,
          concept(made.refs.concept, { priorView: stranger }),
        ),
      ),
    ).toEqual({
      status: "new_view_required",
    });
  });
});

describe("view lifecycle at the read seam", () => {
  test("purging a discovery cursor erases even an empty final-page baseline", async () => {
    const { scene: made } = await scene();
    const input = { operation: "find_concepts", label: "Bayesian updating", cursor: made.refs.concept.token,
      valid: { kind: "all" }, knownAt: { kind: "current" } };
    const first = resultOf(readWorldView(made.reader, input));
    if (first.status !== "current" || !("validUntil" in first)) throw new Error("no final-page baseline");
    expect(first.data).toMatchObject({ matches: [] });
    purgeEvents(made.db, made.vaultPath, { event_id: made.visible.concept.eventId }, "synthetic-cursor-purge");
    expect(resultOf(readWorldView(made.reader, { ...input, priorView: first.view }))).toEqual({ status: "new_view_required" });
  });
  test("expiry, eviction, wrong principal, grant change and purge all require a new view", async () => {
    const { scene: made, owner } = await scene();
    const read = (extra: Record<string, unknown> = {}) => resultOf(readWorldView(owner, concept(made.visible.concept.ref!, extra)));
    const first = read();
    if (first.status !== "current" || !("validUntil" in first)) throw new Error("no baseline");
    expect(resultOf(readWorldView(made.reader, concept(made.refs.concept, { priorView: first.view })))).toEqual({ status: "new_view_required" });
    made.db.query("UPDATE world_view_tokens SET expires_at='2000-01-01T00:00:00.000Z'").run();
    expect(read({ priorView: first.view })).toEqual({ status: "new_view_required" });
    const oldest = read();
    if (oldest.status !== "current" || !("validUntil" in oldest)) throw new Error("no baseline");
    for (let i = 0; i < 16; i++) read();
    expect(read({ priorView: oldest.view })).toEqual({ status: "new_view_required" });
    expect(made.db.query("SELECT count(*) AS n, sum(bytes) AS bytes FROM world_view_tokens WHERE partition_id=0").get()).toMatchObject({ n: 16 });
    const own = read();
    if (own.status !== "current" || !("validUntil" in own)) throw new Error("no baseline");
    purgeEvents(made.db, made.vaultPath, { event_id: made.visible.concept.eventId }, "synthetic-view-purge");
    expect(read({ priorView: own.view })).toEqual({ status: "new_view_required" });
    expect(made.db.query("SELECT count(*) AS n FROM world_view_tokens WHERE partition_id=0").get()).toEqual({ n: 0 });
    expect(made.db.query("SELECT count(*) AS n FROM world_view_token_deps WHERE namespace_id IN (SELECT namespace_id FROM world_authorization_namespaces WHERE principal_id='owner')").get()).toEqual({ n: 0 });
  });

  // Oracle binding: world-concept-design#a_narrowed_old_view (fixed stale-baseline response).
  test("narrowing a live grant erases the baseline immediately", async () => {
    const { scene: made } = await scene();
    const first = resultOf(readWorldView(made.reader, concept(made.refs.concept)));
    if (first.status !== "current" || !("validUntil" in first)) throw new Error("no baseline");
    setGrant(made.db, "narrow-reader", { subjects: ["topic:bayes"] });
    expect(resultOf(readWorldView(made.reader, concept(made.refs.concept, { priorView: first.view })))).toEqual({ status: "new_view_required" });
  });

  test("a grant narrowed between admission and snapshot is revalidated inside the snapshot", async () => {
    const { scene: made } = await scene();
    let changed = false;
    const db = new Proxy(made.db, { get(target, key) {
      if (key === "transaction") return (run: () => unknown) => {
        if (!changed) { changed = true; setGrant(target, "narrow-reader", { subjects: [] }); }
        return target.transaction(run);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const fresh = resultOf(readWorldView({ ...made.reader, db }, { operation: "find_concepts", label: "Bayesian", valid: { kind: "all" }, knownAt: { kind: "current" } }));
    expect(fresh).toMatchObject({ status: "current", data: { matches: [] } });
  });

  test("an owner correction changes the complete projection, and visible unfinished work is incomplete", async () => {
    const { scene: made, owner } = await scene();
    const first = resultOf(readWorldView(owner, concept(made.visible.concept.ref!)));
    if (first.status !== "current" || !("validUntil" in first)) throw new Error("no baseline");
    await correct({ db: made.db, vault_path: made.vaultPath }, { statement: "A corrected definition", target: { claim_id: made.visible.concept.claims[2]! } });
    const changed = resultOf(readWorldView(owner, concept(made.visible.concept.ref!, { priorView: first.view })));
    expect(changed).toMatchObject({ status: "current", view: { kind: "view" } });
    expect(JSON.stringify(changed)).toContain("A corrected definition");
    if (changed.status !== "current" || !("validUntil" in changed)) throw new Error("no revised baseline");
    made.db.query("INSERT INTO checkpoints(connector_id,source_key,cursor,mode,updated_at,last_run_at,last_result,backfill_complete) VALUES ('world.fixture',?,NULL,'backfill','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','{}',0) ON CONFLICT(connector_id,source_key) DO UPDATE SET backfill_complete=0").run(made.visible.concept.sourceKey);
    expect(resultOf(readWorldView(owner, concept(made.visible.concept.ref!, { priorView: changed.view })))).toMatchObject({ status: "incomplete", reasons: ["coverage"] });
  });

  test("token issuance failure rolls eviction back and keeps the authorized body", async () => {
    const { scene: made, owner } = await scene();
    const first = resultOf(readWorldView(owner, concept(made.visible.concept.ref!)));
    made.db.exec("CREATE TEMP TRIGGER reject_view BEFORE INSERT ON world_view_tokens BEGIN SELECT RAISE(ABORT,'synthetic store failure'); END");
    expect(resultOf(readWorldView(owner, concept(made.visible.concept.ref!)))).toMatchObject({ status: "current", view: { status: "not_issued" } });
    if (first.status !== "current" || !("validUntil" in first)) throw new Error("no baseline");
    expect(resultOf(readWorldView(owner, concept(made.visible.concept.ref!, { priorView: first.view })))).toEqual({ status: "unchanged", view: first.view, validUntil: first.validUntil });
  });

  // Oracle binding: world-concept-design#a_hidden_mutation (authorized equality and work).
  test("hidden changes preserve unchanged bytes, validity, errors and read work", async () => {
    await assertNoninterference({
      mutations: HIDDEN_MUTATIONS,
      cases: (made) => {
        const first = resultOf(readWorldView(made.reader, concept(made.refs.concept)));
        if (first.status !== "current" || !("validUntil" in first)) throw new Error("no baseline");
        const hashes = JSON.stringify(made.db.query("SELECT token_hash FROM world_view_tokens WHERE partition_id=(SELECT partition_id FROM world_view_partitions WHERE principal_id=?) ORDER BY created_at, token_hash").all(made.reader.principal.kind === "agent" ? made.reader.principal.agent.agent_id : "owner"));
        const shared = resultOf(readWorldView({ ...made.reader, principal: OWNER }, { operation: "share", of: { operation: "concept", concept: made.visible.concept.ref }, valid: { kind: "all" }, knownAt: { kind: "current" } }));
        if (!("data" in shared) || shared.data.schema !== "kizuki.resume-handle/v1") throw new Error("no handle");
        const handle = shared.data.handle;
        return [{ name: "unchanged view and eviction order", run: (ctx) => {
          const result = readWorldView(ctx, concept(made.refs.concept, { priorView: first.view }));
          expect(JSON.stringify(made.db.query("SELECT token_hash FROM world_view_tokens WHERE partition_id=(SELECT partition_id FROM world_view_partitions WHERE principal_id=?) ORDER BY created_at, token_hash").all(made.reader.principal.kind === "agent" ? made.reader.principal.agent.agent_id : "owner"))).toBe(hashes);
          return result;
        } }, { name: "unknown baseline", run: (ctx) => readWorldView(ctx, concept(made.refs.concept, { priorView: { kind: "view", token: "A".repeat(43) } })) },
        { name: "clipped resume", run: (ctx) => readWorldView(ctx, { operation: "resume", handle, valid: { kind: "all" }, knownAt: { kind: "current" } }) },
        { name: "unknown resume", run: (ctx) => readWorldView(ctx, { operation: "resume", handle: "A".repeat(43), valid: { kind: "all" }, knownAt: { kind: "current" } }) }];
      },
    });
  });

  test("share is noninterfering in bytes and work with a fixed issuance instant", async () => {
    setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      await assertNoninterference({ mutations: HIDDEN_MUTATIONS, cases: (made) => [{ name: "share", run: (ctx) => {
        const value = readWorldView(ctx, { operation: "share", of: { operation: "concept", concept: made.refs.concept }, valid: { kind: "all" }, knownAt: { kind: "current" } });
        // The random bearer is the only nondeterministic output; times, state and work remain checked.
        if (!("result" in value) || !("data" in value.result) || value.result.data.schema !== "kizuki.resume-handle/v1") return value;
        return { ...value, result: { ...value.result, data: { ...value.result.data, handle: "<random handle>" } } };
      } }] });
    } finally { setSystemTime(); }
  });
});
