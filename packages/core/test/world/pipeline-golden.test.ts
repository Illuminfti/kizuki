/**
 * The world read path pinned before and after the projection is staged.
 * Each test drives `world_view` as a client would and compares the whole
 * trace with a file in `golden/`. A pipeline change that moves a byte, a key,
 * a gap or the order of a relation fails here. See helpers/world-golden.ts.
 */
import { createHash } from "node:crypto";
import { expect, setDefaultTimeout, test } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant, setSourceGrant } from "../../src/ledger/source-grants";
import type { ServeContext } from "../../src/serving/types";
import { OWNER } from "../../src/agents";
import {
  expectGolden,
  goldenReader,
  goldenScene,
  goldenText,
  type GoldenScene,
  type WireObjectRef,
} from "../helpers/world-golden";
import { enrollSource, worldSeed } from "../helpers/world-seed";

setDefaultTimeout(120_000);

const golden = (name: string, value: unknown) => expect(expectGolden(name, value)).toBeNull();

/** Every read a client makes about the scene's Concepts and Situations, under one grant. */
function readScene(ctx: ServeContext): Record<string, unknown> {
  const reader = goldenReader(ctx);
  const concepts = reader.find("find_concepts (every)", "find_concepts", "");
  reader.find("find_concepts (bayes)", "find_concepts", "bayes");
  reader.find("find_concepts (no match)", "find_concepts", "zzzz");
  reader.find("find_situations (every)", "find_situations", "");
  const ref = (labels: readonly { labels: string[]; ref: WireObjectRef }[], text: string): WireObjectRef | undefined =>
    labels.find((match) => match.labels.includes(text))?.ref;
  const bayes = ref(concepts, "Bayesian updating");
  if (bayes !== undefined) {
    reader.card("concept (bayes)", "concept", bayes);
    reader.card("concept (bayes, valid at)", "concept", bayes, { valid: { kind: "at", at: "2026-06-01T00:00:00.000Z" } });
    reader.card("concept (bayes, valid before)", "concept", bayes, { valid: { kind: "at", at: "2025-01-01T00:00:00.000Z" } });
    reader.card("concept (bayes, valid overlap)", "concept", bayes, {
      valid: { kind: "overlap", from: "2026-02-01T00:00:00.000Z", until: "2026-03-01T00:00:00.000Z" },
    });
    reader.card("concept (bayes, unknown time only)", "concept", bayes, { valid: { kind: "unknown_only" } });
    reader.card("concept (bayes, known at a time)", "concept", bayes, {
      knownAt: { kind: "time", at: "2026-06-01T00:00:00.000Z" },
    });
    reader.card("situation (a concept ref)", "situation", bayes);
  }
  const probability = ref(concepts, "Probability");
  if (probability !== undefined) reader.card("concept (probability)", "concept", probability);
  const hidden = ref(concepts, "Bayesian priors");
  if (hidden !== undefined) reader.card("concept (private)", "concept", hidden);
  const situations = reader.matches(reader.trace["find_situations (every)"]);
  const launch = ref(situations, "Launch plan");
  if (launch !== undefined) {
    reader.card("situation (launch)", "situation", launch);
    reader.card("situation (launch, known at a time)", "situation", launch, {
      knownAt: { kind: "time", at: "2026-06-01T00:00:00.000Z" },
    });
  }
  const archive = ref(situations, "Archive plan");
  if (archive !== undefined) reader.card("situation (archive)", "situation", archive);
  reader.find("find_situations (known at a time)", "find_situations", "", { knownAt: { kind: "time", at: "2026-06-01T00:00:00.000Z" } });
  return reader.trace;
}

/** The reads a change of state is judged by: discovery, one Concept and one Situation. */
function readCore(ctx: ServeContext): Record<string, unknown> {
  const reader = goldenReader(ctx);
  const concept = reader.find("find_concepts", "find_concepts", "Bayesian updating")[0];
  const situation = reader.find("find_situations", "find_situations", "Launch")[0];
  if (concept !== undefined) reader.card("concept", "concept", concept.ref);
  if (situation !== undefined) reader.card("situation", "situation", situation.ref);
  return reader.trace;
}

async function withScene(run: (scene: GoldenScene) => void | Promise<void>): Promise<void> {
  const scene = await goldenScene();
  try {
    await run(scene);
  } finally {
    scene.dispose();
  }
}

test("the owner sees both sources: cards, discovery and every valid-time query", async () => {
  await withScene((scene) => golden("owner", readScene(scene.owner)));
});

test("a narrow agent sees only what its grant reaches, and the private source leaves no trace", async () => {
  await withScene((scene) => golden("narrow", readScene(scene.narrow)));
});

test("revoking the public source removes its cards and matches, and a held ref stops resolving", async () => {
  await withScene((scene) => {
    const trace: Record<string, unknown> = { before: readCore(scene.owner) };
    const reader = goldenReader(scene.owner);
    const held = reader.find("held", "find_concepts", "Bayesian updating")[0]!.ref;
    revokeSourceGrant(scene.db, {
      source_key: scene.publicSource,
      expected_revision: 1,
      operation_id: "golden-revoke",
    });
    trace.after = readCore(scene.owner);
    reader.card("held ref", "concept", held);
    trace.heldRef = reader.trace;
    golden("revoked", trace);
  });
});

test("purging an event removes exactly its claims from the card and the labels", async () => {
  await withScene((scene) => {
    const before = readCore(scene.owner);
    purgeEvents(scene.db, scene.vaultPath, { event_id: scene.extraEventId }, "golden purge");
    golden("purged", { before, after: readCore(scene.owner) });
  });
});

test("an unfinished import and unconsumed extraction make every answer partial", async () => {
  await withScene((scene) => {
    const now = new Date().toISOString();
    const result = JSON.stringify({ stored: 1, duplicates: 0, errors: [], proposals_created: 0, withdrawn: 0, retractions_filed: 0, cursor: null });
    scene.db
      .query(
        `INSERT INTO checkpoints (connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result, backfill_complete, backfill_cursor, sync_cursor)
         VALUES ('world.fixture', ?, NULL, 'sync', ?, ?, ?, 0, NULL, NULL)`,
      )
      .run(scene.publicSource, now, now, result);
    golden("partial-import", readCore(scene.owner));
    setSourceGrant(scene.db, {
      source_key: scene.publicSource,
      expected_revision: 1,
      operation_id: "golden-extract-grant",
      policy: {
        purposes: ["capture", "derive", "recall", "correction", "export", "extract"],
        allowed_fields: ["text", "subjects", "metadata", "attachments"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        sensitivity_floor: "public",
      },
    });
    golden("partial-backlog", readCore(scene.owner));
  });
});

function freshOwner() {
  const db = openLedger(":memory:");
  const ctx: ServeContext = { db, vaultPath: "/tmp/world-golden", principal: OWNER };
  return { db, ctx, sourceKey: enrollSource(db, "world.fixture", "public") };
}

test("discovery pages by cursor: a full first page, then the rest, each sorted by label", async () => {
  const { db, ctx, sourceKey } = freshOwner();
  try {
    for (let index = 0; index < 34; index += 1) {
      const label = `Concept ${String(index).padStart(2, "0")}`;
      await worldSeed(db, { sourceKey, subject: `topic:c${index}`, label, predicates: [], discover: false });
    }
    const reader = goldenReader(ctx);
    const first = reader.call("first", { operation: "find_concepts", label: "Concept" }) as {
      result: { status: string; data: { matches: { labels: string[] }[]; cursor: string | null; coverage: unknown } };
    };
    const cursor = first.result.data.cursor;
    expect(cursor).not.toBeNull();
    const second = reader.call("second", { operation: "find_concepts", label: "Concept", cursor }) as typeof first;
    const shape = (page: typeof first) => ({
      status: page.result.status,
      count: page.result.data.matches.length,
      sortedByLabel: page.result.data.matches.every(
        (match, at, all) => at === 0 || (all[at - 1]!.labels[0] ?? "").localeCompare(match.labels[0] ?? "") <= 0,
      ),
      cursor: page.result.data.cursor,
      coverage: page.result.data.coverage,
    });
    const union = [...first.result.data.matches, ...second.result.data.matches].map((match) => match.labels[0]).sort();
    golden("discovery-paged", { first: shape(first), second: shape(second), union });
  } finally {
    db.close();
  }
});

test("a Concept with more claims than one card carries is cut at the bound and says so", async () => {
  const { db, ctx, sourceKey } = freshOwner();
  try {
    await worldSeed(db, {
      sourceKey,
      subject: "topic:many",
      label: "Many examples",
      discover: false,
      predicates: Array.from({ length: 130 }, (_, index) => ({
        predicate: "concept.example",
        object: { kind: "literal" as const, value: `Example number ${index}` },
      })),
    });
    const reader = goldenReader(ctx);
    const found = reader.find("find", "find_concepts", "Many");
    const card = reader.card("card", "concept", found[0]!.ref) as {
      result: { status: string; data: { relations: unknown[]; coverage: unknown } };
    };
    const { relations } = card.result.data;
    golden("overflow", {
      find: reader.trace["find"],
      cardStatus: card.result.status,
      relationCount: relations.length,
      firstRelation: relations[0],
      lastRelation: relations[relations.length - 1],
      coverage: card.result.data.coverage,
      digest: createHash("sha256").update(goldenText(card)).digest("hex"),
    });
  } finally {
    db.close();
  }
});
