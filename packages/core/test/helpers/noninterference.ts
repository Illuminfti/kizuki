/**
 * Hidden-mutation noninterference driver.
 *
 * A reader whose grant cannot see some evidence must get the same answer
 * whether or not that evidence exists or changes. For each hidden mutation the
 * driver builds a fresh scene, observes every read case as the narrow reader,
 * applies the mutation to state the reader cannot see, observes again, and
 * reports any difference in three dimensions:
 *
 * - bytes: the canonical output, normalizing only `at` and wire-token values;
 * - error: the class and text of a refusal;
 * - stats: work counters, the timing proxy (wall-clock time is not promised).
 *
 * The work counters are SQL statements run through the read's own connection
 * until the projection reports its own frame statistics; a case may return
 * richer counters with `stats`.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { insertClaim } from "../../src/claims/store";
import { correct } from "../../src/correction/correct";
import { initGraph } from "../../src/graph/schema";
import { openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { initSearch } from "../../src/search/schema";
import { serveWorldView } from "../../src/serving/world-view";
import type { ServeContext } from "../../src/serving/types";
import { tempVault } from "./vault";
import { worldSeed, type WorldSeed } from "./world-seed";

export type WorkStats = Readonly<Record<string, number>>;

export interface Observation {
  readonly bytes: string;
  readonly error: {
    readonly name: string;
    readonly code: string | null;
    readonly message: string;
  } | null;
  readonly stats: WorkStats;
}

export interface ReadCase {
  readonly name: string;
  /** One read as the reader. Statements must go through `ctx.db` to be counted. */
  run(ctx: ServeContext): unknown | Promise<unknown>;
  /** Extra counters a read reports about its own work, merged over the statement counts. */
  stats?(): WorkStats;
}

export interface NoninterferenceScene {
  readonly db: Database;
  readonly vaultPath: string;
  /** The narrow reader: public ceiling, only the two visible subjects. */
  readonly reader: ServeContext;
  readonly visible: {
    readonly concept: WorldSeed;
    readonly situation: WorldSeed;
  };
  /** Private evidence in a source the reader's grant cannot reach. */
  readonly hidden: WorldSeed;
  /** Wire refs of the visible objects as the reader holds them. */
  readonly refs: {
    readonly concept: WireObjectRef;
    readonly situation: WireObjectRef;
  };
  dispose(): void;
}

export interface WireObjectRef {
  readonly kind: "object";
  readonly token: string;
}

export interface HiddenMutation {
  readonly name: string;
  apply(scene: NoninterferenceScene): Promise<void> | void;
}

export interface Leak {
  readonly mutation: string;
  readonly case: string;
  readonly dimension: "bytes" | "error" | "stats" | "control";
  readonly before: string;
  readonly after: string;
}

const VISIBLE_SUBJECTS = ["topic:bayes", "project:launch"] as const;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Fresh ledger in a temporary vault with public visible objects and a private hidden one. */
export async function hiddenScene(): Promise<NoninterferenceScene> {
  const vault = tempVault("kizuki-noninterference-");
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  try {
    initSearch(db);
    initGraph(db);
    const concept = await worldSeed(db, {
      subject: "topic:bayes",
      label: "Bayesian updating",
    });
    const situation = await worldSeed(db, {
      kind: "situation",
      subject: "project:launch",
      label: "Launch plan",
    });
    const agent = addAgent(db, "narrow-reader", {
      ...OWNER_AGENT_GRANT,
      ceiling: "public",
      subjects: [...VISIBLE_SUBJECTS],
    });
    const principal = authenticate(db, agent.token);
    if (principal === null)
      throw new Error("the narrow reader did not authenticate");
    const reader: ServeContext = { db, vaultPath: vault.path, principal };
    const hidden = await worldSeed(db, {
      subject: "topic:hidden",
      label: "Bayesian priors",
      floor: "private",
    });
    const ref = (
      operation: "find_concepts" | "find_situations",
      label: string,
    ): WireObjectRef => {
      const found = serveWorldView(reader, {
        operation,
        label,
        valid: { kind: "all" },
        knownAt: { kind: "current" },
      }).data;
      const matches =
        "result" in found &&
        found.result.status !== "unavailable" &&
        "matches" in found.result.data
          ? found.result.data.matches
          : [];
      if (matches[0] === undefined)
        throw new Error(`the reader cannot see ${label}`);
      return matches[0].ref;
    };
    return {
      db,
      vaultPath: vault.path,
      reader,
      visible: { concept, situation },
      hidden,
      refs: {
        concept: ref("find_concepts", "Bayesian"),
        situation: ref("find_situations", "Launch"),
      },
      dispose() {
        db.close();
        vault.dispose();
      },
    };
  } catch (error) {
    db.close();
    vault.dispose();
    throw error;
  }
}

const view = (operation: string, rest: Record<string, unknown>) => ({
  operation,
  ...rest,
  valid: { kind: "all" },
  knownAt: { kind: "current" },
});

/** The four world_view operations plus the refusals a hidden object must be indistinguishable from. */
export function worldViewCases(
  scene: NoninterferenceScene,
): readonly ReadCase[] {
  const read =
    (input: unknown): ReadCase["run"] =>
    (ctx) =>
      serveWorldView(ctx, input as Record<string, unknown>);
  const foreign = scene.hidden.ref;
  return [
    {
      name: "find_concepts (label of visible and hidden objects)",
      run: read(view("find_concepts", { label: "Bayesian" })),
    },
    {
      name: "find_concepts (label only hidden evidence has)",
      run: read(view("find_concepts", { label: "priors" })),
    },
    {
      name: "find_situations",
      run: read(view("find_situations", { label: "Launch" })),
    },
    {
      name: "concept",
      run: read(view("concept", { concept: scene.refs.concept })),
    },
    {
      name: "situation",
      run: read(view("situation", { situation: scene.refs.situation })),
    },
    ...(foreign === null
      ? []
      : [
          {
            name: "concept (the owner's ref to hidden evidence)",
            run: read(view("concept", { concept: foreign })),
          },
        ]),
    {
      name: "concept (a well-formed ref nothing was issued for)",
      run: read(
        view("concept", { concept: { kind: "object", token: "A".repeat(43) } }),
      ),
    },
    {
      name: "refusal (invalid input)",
      run: read({ operation: "concept", concept: "not-a-ref" }),
    },
  ];
}

const hiddenSubjectRef = (scene: NoninterferenceScene) => ({
  kind: "supplied" as const,
  id: "topic:hidden",
  namespace: {
    connector_id: "world.fixture",
    source_key: scene.hidden.sourceKey,
  },
});

/** The hidden mutation library. Every entry changes only state the narrow reader cannot see. */
export const HIDDEN_MUTATIONS: readonly HiddenMutation[] = [
  {
    name: "hidden claim",
    apply: async (scene) => {
      await worldSeed(scene.db, {
        subject: "topic:hidden-two",
        label: "Bayesian updating",
        floor: "private",
        discover: false,
      });
    },
  },
  {
    name: "hidden source revoke",
    apply: (scene) => {
      revokeSourceGrant(scene.db, {
        source_key: scene.hidden.sourceKey,
        expected_revision: 1,
        operation_id: "noninterference-revoke",
      });
    },
  },
  {
    name: "hidden purge",
    apply: (scene) => {
      purgeEvents(
        scene.db,
        scene.vaultPath,
        { event_id: scene.hidden.eventId },
        "synthetic-hidden-purge",
      );
    },
  },
  {
    name: "hidden identity merge",
    apply: async (scene) => {
      const stored = await insertClaim(
        { db: scene.db },
        {
          kind: "claim",
          subject: "topic:hidden",
          predicate: "identity.same_as",
          object: VISIBLE_SUBJECTS[0],
          body: "topic:hidden is the same as topic:bayes",
          provenance: [scene.hidden.eventId],
          producer: "deterministic",
          confidence: 0.8,
          sensitivity: "private",
          subjects: ["topic:hidden"],
        },
      );
      if (stored.outcome !== "stored")
        throw new Error(`identity claim was ${stored.outcome}`);
    },
  },
  {
    name: "hidden owner correction",
    apply: async (scene) => {
      await correct(
        { db: scene.db, vault_path: scene.vaultPath },
        {
          statement: "Use prior odds and the likelihood ratio.",
          target: { claim_id: scene.hidden.claims[2]! },
        },
      );
    },
  },
  {
    name: "hidden supersession",
    apply: async (scene) => {
      await worldSeed(scene.db, {
        sourceKey: scene.hidden.sourceKey,
        subject: "topic:hidden",
        label: "Bayesian priors",
        floor: "private",
        predicates: [
          {
            predicate: "concept.definition",
            object: { kind: "literal", value: "Start from a prior belief" },
          },
        ],
        discover: false,
      });
    },
  },
  {
    name: "hidden dependency edge",
    apply: async (scene) => {
      await worldSeed(scene.db, {
        sourceKey: scene.hidden.sourceKey,
        subject: "topic:hidden",
        label: "Bayesian priors",
        floor: "private",
        predicates: [
          {
            predicate: "concept.requires",
            object: { kind: "subject", ref: hiddenSubjectRef(scene) },
          },
        ],
        discover: false,
      });
    },
  },
];

/** What a mutation changed in the ledger, so a test can prove a mutation was not a no-op. */
export function ledgerWitness(db: Database): string {
  const rows = (sql: string) => db.query<Record<string, unknown>, []>(sql).all();
  return JSON.stringify([
    rows("SELECT count(*) AS n FROM events"),
    rows("SELECT status, count(*) AS n FROM claims GROUP BY status ORDER BY status"),
    rows("SELECT * FROM source_grants ORDER BY source_key"),
  ]);
}

function canonical(value: unknown, tokens: Map<string, number>): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item, tokens));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [
          key,
          key === "at" && typeof item === "string"
            ? "<at>"
            : canonical(item, tokens),
        ]),
    );
  }
  if (typeof value === "string" && TOKEN.test(value)) {
    if (!tokens.has(value)) tokens.set(value, tokens.size);
    return `<token ${tokens.get(value)}>`;
  }
  return value;
}

/** Sorted-key JSON where only `at` and wire-token values are normalized. */
export function canonicalBytes(value: unknown): string {
  return JSON.stringify(canonical(value, new Map())) ?? "undefined";
}

/** `db` whose executed statements are counted; everything else passes through. */
function counting(db: Database): { db: Database; stats(): WorkStats } {
  let statements = 0;
  const statement = (target: object): object =>
    new Proxy(target, {
      get(inner, property) {
        const value = Reflect.get(inner, property, inner);
        if (typeof value !== "function") return value;
        if (
          property === "get" ||
          property === "all" ||
          property === "run" ||
          property === "values" ||
          property === "iterate"
        ) {
          return (...args: unknown[]) => {
            statements += 1;
            return Reflect.apply(value, inner, args);
          };
        }
        return value.bind(inner);
      },
    });
  const proxy = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "query" || property === "prepare") {
        return (...args: unknown[]) =>
          statement(Reflect.apply(value, target, args) as object);
      }
      if (property === "run" || property === "exec") {
        return (...args: unknown[]) => {
          statements += 1;
          return Reflect.apply(value, target, args);
        };
      }
      return value.bind(target);
    },
  });
  return { db: proxy, stats: () => ({ statements }) };
}

export async function observe(
  ctx: ServeContext,
  kase: ReadCase,
): Promise<Observation> {
  const counted = counting(ctx.db);
  let bytes = "";
  let error: Observation["error"] = null;
  try {
    bytes = canonicalBytes(await kase.run({ ...ctx, db: counted.db }));
  } catch (thrown) {
    const failure = thrown as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
    };
    error = {
      name: typeof failure.name === "string" ? failure.name : typeof thrown,
      code: typeof failure.code === "string" ? failure.code : null,
      message:
        typeof failure.message === "string" ? failure.message : String(thrown),
    };
  }
  return {
    bytes,
    error,
    stats: { ...counted.stats(), ...(kase.stats?.() ?? {}) },
  };
}

function differences(
  before: Observation,
  after: Observation,
): Leak["dimension"][] {
  const found: Leak["dimension"][] = [];
  if (before.bytes !== after.bytes) found.push("bytes");
  if (JSON.stringify(before.error) !== JSON.stringify(after.error))
    found.push("error");
  if (canonicalBytes(before.stats) !== canonicalBytes(after.stats))
    found.push("stats");
  return found;
}

const show = (
  observation: Observation,
  dimension: Leak["dimension"],
): string =>
  dimension === "bytes"
    ? observation.bytes
    : dimension === "error"
      ? JSON.stringify(observation.error)
      : JSON.stringify(observation.stats);

export interface NoninterferenceOptions {
  /** The reads to hold noninterfering, built from the scene the reader lives in. */
  readonly cases: (scene: NoninterferenceScene) => readonly ReadCase[];
  readonly mutations?: readonly HiddenMutation[];
  readonly scene?: () => Promise<NoninterferenceScene>;
}

/**
 * Every leak found. A no-op control runs first for each case: a read that
 * differs from itself is reported as `control`, so a nondeterministic case
 * cannot pass or fail a mutation by accident.
 */
export async function checkNoninterference(
  options: NoninterferenceOptions,
): Promise<Leak[]> {
  const leaks: Leak[] = [];
  for (const mutation of options.mutations ?? HIDDEN_MUTATIONS) {
    const scene = await (options.scene ?? hiddenScene)();
    try {
      const cases = options.cases(scene);
      // The first read of a ref allocates it; later reads reuse it. Warm every case so
      // the baseline and the control see the same state.
      for (const kase of cases) await observe(scene.reader, kase);
      const first: Observation[] = [];
      const control: Observation[] = [];
      for (const kase of cases) first.push(await observe(scene.reader, kase));
      for (const kase of cases) control.push(await observe(scene.reader, kase));
      await mutation.apply(scene);
      for (const [index, kase] of cases.entries()) {
        const before = first[index]!;
        for (const dimension of differences(before, control[index]!)) {
          leaks.push({
            mutation: "(no mutation)",
            case: kase.name,
            dimension: "control",
            before: show(before, dimension),
            after: show(control[index]!, dimension),
          });
        }
        const after = await observe(scene.reader, kase);
        for (const dimension of differences(control[index]!, after)) {
          leaks.push({
            mutation: mutation.name,
            case: kase.name,
            dimension,
            before: show(control[index]!, dimension),
            after: show(after, dimension),
          });
        }
      }
    } finally {
      scene.dispose();
    }
  }
  return leaks;
}

export async function assertNoninterference(
  options: NoninterferenceOptions,
): Promise<void> {
  const leaks = await checkNoninterference(options);
  if (leaks.length === 0) return;
  throw new Error(
    leaks
      .map(
        (leak) =>
          `${leak.mutation} changed ${leak.dimension} of "${leak.case}"\n  before: ${leak.before}\n  after:  ${leak.after}`,
      )
      .join("\n"),
  );
}

/** A read that answers with global row counts. It must fail the driver: it is how the driver proves it can. */
export const LEAKY_GLOBAL_COUNT: ReadCase = {
  name: "self-test (global claim and event counts)",
  run: (ctx) =>
    ctx.db
      .query<{ claims: number; events: number }, []>(
        "SELECT (SELECT count(*) FROM claims) AS claims, (SELECT count(*) FROM events) AS events",
      )
      .get(),
};
