/**
 * A kind that does not ship reaches the pipeline through data alone: a
 * vocabulary module in a test registry, an assembler built from the card kit,
 * and nothing else. These tests read it through the pipeline entry points,
 * because no `world_view` operation exists for it.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import { withWorldPipeline } from "@kizuki/core/testing";
import { OWNER } from "../../src/agents";
import {
  createWorldRegistry,
  worldPredicate,
  type WorldRegistry,
} from "../../src/contracts/world-kinds";
import {
  WORLD_VOCABULARY_MODULES,
  withWorldRegistry,
} from "../../src/contracts/world-vocabulary";
import { openLedger } from "../../src/ledger/db";
import type { ServeContext } from "../../src/serving/types";
import { newReadFrame } from "../../src/world/pipeline/frame";
import { readWorldCard, readWorldMatches } from "../../src/world/pipeline/read";
import { worldNamespace } from "../../src/world/references";
import { testKind } from "../helpers/world-kinds";
import { probeAssembler, validateProbeCard, type ProbeCard } from "../helpers/probe-card";
import { worldSeed } from "../helpers/world-seed";

setDefaultTimeout(120_000);

const text = worldPredicate({ predicate: "probe.text", subject: "concept", objects: ["literal"] });
const answer = worldPredicate({ predicate: "probe.candidate_answer", subject: "concept", objects: ["literal"] });

const registryFor = (over: Parameters<typeof testKind>[1] = {}): WorldRegistry =>
  createWorldRegistry([...WORLD_VOCABULARY_MODULES, testKind("probe", over, [text, answer])]);

/** One read as the owner, inside the transaction the reader opens. */
function read<T>(db: ReturnType<typeof openLedger>, run: (open: () => ReturnType<typeof newReadFrame>) => T): T {
  const ctx: ServeContext = { db, vaultPath: "/tmp/world-pipeline-kinds", principal: OWNER };
  return db
    .transaction(() => {
      const ns = worldNamespace(db, OWNER);
      return run(() => newReadFrame(ctx, ns, { kind: "all" }));
    })
    .immediate();
}

const handleOf = (db: ReturnType<typeof openLedger>, subject: string): string =>
  db.query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?").get(subject)!.handle_id;

test("a kind registered as data is discovered and read as a card of its own codec", async () => {
  const db = openLedger(":memory:");
  try {
    await withWorldRegistry(registryFor(), () =>
      withWorldPipeline({ assemblers: [probeAssembler] }, async () => {
        await worldSeed(db, {
          kind: "probe",
          subject: "probe:idempotency",
          label: "What is idempotency?",
          predicates: [
            { predicate: "probe.text", object: { kind: "literal", value: "What does idempotent mean?" } },
            { predicate: "probe.candidate_answer", object: { kind: "literal", value: "Repeating it changes nothing" } },
          ],
        });
        const found = read(db, (open) => readWorldMatches(open(), "probe", "idempot", null, 100));
        expect(found.schema).toBe("kizuki.probe-matches/v1");
        expect(found.matches.map((match) => match.labels)).toEqual([["What is idempotency?"]]);
        expect(found.coverage.status).toBe("complete_for_query");
        const card = read(db, (open) => readWorldCard(open(), handleOf(db, "probe:idempotency"), "probe")) as ProbeCard;
        expect(validateProbeCard(card).ok).toBe(true);
        expect(card.probe.kind).toBe("probe");
        expect(card.probe.labels.map((label) => label.text)).toEqual(["What is idempotency?"]);
        expect(card.text?.object).toEqual({ kind: "literal", value: "What does idempotent mean?" });
        expect(card.answers.map((relation) => relation.object)).toEqual([{ kind: "literal", value: "Repeating it changes nothing" }]);
        expect(card.coverage.status).toBe("complete_for_query");
      }),
    );
  } finally {
    db.close();
  }
});

test("a registered kind with no assembler has no card, and the shipped kinds are not its cards", async () => {
  const db = openLedger(":memory:");
  try {
    await withWorldRegistry(registryFor(), async () => {
      await worldSeed(db, { kind: "probe", subject: "probe:a", label: "Why?", predicates: [] });
      const handle = handleOf(db, "probe:a");
      expect(read(db, (open) => readWorldCard(open(), handle, "probe"))).toBeNull();
      expect(read(db, (open) => readWorldCard(open(), handle, "concept"))).toBeNull();
    });
  } finally {
    db.close();
  }
});

test("a kind the registry does not know is refused loudly, not read as empty", () => {
  const db = openLedger(":memory:");
  try {
    expect(() => read(db, (open) => readWorldMatches(open(), "ghost", "", null, 10))).toThrow("ghost is not registered");
    expect(() => read(db, (open) => readWorldCard(open(), "0".repeat(32), "ghost"))).toThrow("ghost is not registered");
  } finally {
    db.close();
  }
});

test("only a kind some path can fill may report an empty page as complete", async () => {
  const db = openLedger(":memory:");
  try {
    const firstPage = (over: Parameters<typeof testKind>[1]) =>
      withWorldRegistry(registryFor(over), () => read(db, (open) => readWorldMatches(open(), "probe", "", null, 10)));
    const dark = firstPage({});
    expect(dark.matches).toEqual([]);
    expect(dark.coverage).toMatchObject({ status: "partial", gaps: ["coverage"] });
    expect(firstPage({ population: [] }).coverage.gaps).toEqual(["coverage"]);
    expect(firstPage({ offeredToProducer: true }).coverage).toMatchObject({ status: "complete_for_query", gaps: [] });
    expect(firstPage({ population: ["owner_assertion"] }).coverage.gaps).toEqual([]);
    expect(firstPage({ population: ["derived"] }).coverage.gaps).toEqual([]);
    // Past the first page an empty tail says nothing about the kind.
    const tail = withWorldRegistry(registryFor(), () =>
      read(db, (open) => readWorldMatches(open(), "probe", "", "f".repeat(32), 10)),
    );
    expect(tail.coverage.gaps).toEqual([]);
  } finally {
    db.close();
  }
});

test("a dark kind that holds claims is complete, and its label filter is honest about what it leaves", async () => {
  const db = openLedger(":memory:");
  try {
    await withWorldRegistry(registryFor(), async () => {
      await worldSeed(db, { kind: "probe", subject: "probe:a", label: "Why is the sky blue?", predicates: [] });
      const all = read(db, (open) => readWorldMatches(open(), "probe", "", null, 10));
      expect(all.matches).toHaveLength(1);
      expect(all.coverage.gaps).toEqual([]);
      const none = read(db, (open) => readWorldMatches(open(), "probe", "zzzz", null, 10));
      expect(none.matches).toEqual([]);
      expect(none.coverage.gaps).toEqual([]);
    });
  } finally {
    db.close();
  }
});
