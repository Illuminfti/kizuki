/**
 * The seams of the staged projection: a new enricher, collector, grouper or
 * kind is a registration, and none of them can widen what a reader may see.
 * Reads go through `world_view`; the stage lists are swapped with
 * `withWorldPipeline`, which restores them when the read is done.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateConceptCard } from "../../src/contracts/concept-card";
import type { ConceptCard } from "../../src/contracts/concept-card";
import type { Enricher } from "../../src/world/pipeline/enrich";
import type { Collector } from "../../src/world/pipeline/collect";
import type { Grouper } from "../../src/world/pipeline/group";
import { readWorldView } from "../../src/serving/world-view";
import { WORLD_REGISTRY } from "../../src/contracts/world-vocabulary";
import { KIND_ASSEMBLERS } from "../../src/world/kinds";
import { withWorldPipeline } from "../../src/world/pipeline/read";
import {
  goldenReader,
  goldenScene,
  goldenText,
  type GoldenScene,
  type WireObjectRef,
} from "../helpers/world-golden";

setDefaultTimeout(120_000);

let scene: GoldenScene;
beforeAll(async () => {
  scene = await goldenScene();
});
afterAll(() => scene.dispose());

interface CardRead {
  status: string;
  reasons: readonly string[];
  card: ConceptCard;
  text: string;
}

/** The Concept card for the label, read as `ctx` through `world_view`. */
function conceptCard(ctx = scene.owner, label = "Bayesian updating"): CardRead {
  const reader = goldenReader(ctx);
  const ref: WireObjectRef = reader.find("find", "find_concepts", label)[0]!.ref;
  const served = reader.card("card", "concept", ref) as {
    result: { status: string; data: ConceptCard; reasons?: string[] };
  };
  return {
    status: served.result.status,
    reasons: served.result.reasons ?? [],
    card: served.result.data,
    text: goldenText(served),
  };
}

/** The same read without the gate, which turns any failure into an opaque one. */
function rawConceptRead(): unknown {
  const ref: WireObjectRef = goldenReader(scene.owner).find("find", "find_concepts", "Bayesian updating")[0]!.ref;
  return readWorldView(scene.owner, {
    operation: "concept",
    concept: ref,
    valid: { kind: "all" },
    knownAt: { kind: "current" },
  });
}

const conflictAndGap: Enricher = (_frame, body) => ({
  ...body,
  claims: body.claims.map((claim) =>
    claim.relation.predicate === "concept.definition"
      ? { ...claim, relation: { ...claim.relation, conflict: "present" as const } }
      : claim,
  ),
  gaps: [...body.gaps, "stale_dependencies"],
});

describe("enrichers", () => {
  test("an injected enricher sets a relation conflict and a gap, the card stays valid, and removing it restores the read", () => {
    const before = conceptCard();
    expect(before.status).toBe("current");
    const injected = withWorldPipeline({ enrichers: [conflictAndGap] }, () => conceptCard());
    expect(validateConceptCard(injected.card).ok).toBe(true);
    expect(injected.status).toBe("incomplete");
    expect(injected.reasons).toEqual(["stale_dependencies"]);
    expect(injected.card.coverage.gaps).toEqual(["stale_dependencies"]);
    expect(injected.card.definitions.map((relation) => relation.conflict)).toEqual(["present"]);
    expect(injected.card.relations.every((relation) => relation.conflict === "unknown")).toBe(true);
    expect(injected.text).not.toBe(before.text);
    expect(conceptCard().text).toBe(before.text);
  });

  test("an enricher that adds, drops or reorders a claim is refused rather than served", () => {
    const drop: Enricher = (_frame, body) => ({ ...body, claims: body.claims.slice(1) });
    const swap: Enricher = (_frame, body) => ({ ...body, claims: [...body.claims].reverse() });
    for (const enricher of [drop, swap]) {
      expect(() => withWorldPipeline({ enrichers: [enricher] }, rawConceptRead)).toThrow(
        "must not add, drop or reorder claims",
      );
    }
  });

  test("enrichers run in order, each on the body the one before left", () => {
    const seen: string[] = [];
    const first: Enricher = (_frame, body) => {
      seen.push(`first:${body.gaps.length}`);
      return { ...body, gaps: [...body.gaps, "coverage"] };
    };
    const second: Enricher = (_frame, body) => {
      seen.push(`second:${body.gaps.length}`);
      return { ...body, gaps: [...body.gaps, "coverage"] };
    };
    const read = withWorldPipeline({ enrichers: [first, second] }, () => conceptCard());
    expect(seen).toEqual(["first:0", "second:1"]);
    expect(read.card.coverage.gaps).toEqual(["coverage"]);
  });
});

describe("collectors", () => {
  test("an id a collector names is verified like any other, so a hidden claim never surfaces", () => {
    const hidden = scene.db
      .query<{ claim_id: string }, []>(
        "SELECT claim_id FROM claim_v2_semantics WHERE subject_id='topic:hidden'",
      )
      .all()
      .map((row) => row.claim_id);
    expect(hidden.length).toBeGreaterThan(0);
    const nominate: Collector = () => hidden;
    const plain = conceptCard(scene.narrow);
    const nominated = withWorldPipeline({ collectors: [nominate] }, () => conceptCard(scene.narrow));
    expect(nominated.text).toBe(plain.text);
  });

  test("an id no claim has is dropped, not thrown", () => {
    const nominate: Collector = () => ["01ZZZZZZZZZZZZZZZZZZZZZZZZ", "not even an id"];
    const plain = conceptCard();
    expect(withWorldPipeline({ collectors: [nominate] }, () => conceptCard()).text).toBe(plain.text);
  });
});

describe("groupers", () => {
  const handleOf = (subject: string): string =>
    scene.db
      .query<{ handle_id: string }, [string]>("SELECT handle_id FROM semantic_bindings WHERE raw_id=?")
      .get(subject)!.handle_id;

  test("a grouper that widens the cluster unions the members' relations and sets the resolution", () => {
    const probability = handleOf("topic:probability");
    const merge: Grouper = (_frame, cluster) => ({
      ...cluster,
      members: [...cluster.members, probability],
      resolution: "resolved",
    });
    const plain = conceptCard();
    const merged = withWorldPipeline({ groupers: [merge] }, () => conceptCard());
    expect(plain.card.concept.resolution).toBe("distinct");
    expect(merged.card.concept.resolution).toBe("resolved");
    expect(merged.card.concept.ref).toEqual(plain.card.concept.ref);
    const labels = (card: ConceptCard) => card.concept.labels.map((label) => label.text).sort();
    expect(labels(plain.card)).toEqual(["Bayesian updating"]);
    expect(labels(merged.card)).toEqual(["Bayesian updating", "Probability"]);
    expect(validateConceptCard(merged.card).ok).toBe(true);
  });

  test("a grouper that loses the requested handle is refused", () => {
    const lose: Grouper = (_frame, cluster) => ({ ...cluster, members: [handleOf("topic:probability")] });
    expect(() => withWorldPipeline({ groupers: [lose] }, rawConceptRead)).toThrow(
      "must keep the requested handle",
    );
  });
});

describe("the stage lists", () => {
  test("a test swap does not nest and leaves the shipped lists behind it", () => {
    expect(() =>
      withWorldPipeline({}, () => withWorldPipeline({}, () => undefined)),
    ).toThrow("sequential-only");
    expect(conceptCard().status).toBe("current");
  });

  test("each shipped assembler serves one registered kind, once", () => {
    const ids = KIND_ASSEMBLERS.map((assembler) => assembler.kind);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(WORLD_REGISTRY.kind(id)).toBeDefined();
  });

  test("every slot marker appears exactly once in the file that owns its list", () => {
    const root = join(import.meta.dir, "../../src/world");
    const markers = (file: string) =>
      [...readFileSync(join(root, file), "utf8").matchAll(/^\s*\/\/ slot: (\w+)\s*$/gm)].map((match) => match[1]!);
    expect(markers("pipeline/enrichers.ts")).toEqual(["card", "consol"]);
    expect(markers("pipeline/collect.ts")).toEqual(["ident"]);
    expect(markers("pipeline/group.ts")).toEqual(["ident"]);
    expect(markers("kinds/index.ts")).toEqual(["quest", "people", "skill", "sit2", "art"]);
  });
});
