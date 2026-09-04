import { describe, expect, test } from "bun:test";
import {
  applyAdjacencyBoost,
  rrfFusion,
  walkNeighbors,
} from "../vendor/recipe";
import type { RecipeCandidate, RecipeEdge } from "../vendor/recipe";
import { NEIGHBOR_CAP_PER_HOP } from "../vendor/recipe/graph";
import { finalizeRecipe } from "../src/rank";

function candidate(
  id: string,
  chunk_id: number,
  extras: Partial<RecipeCandidate> = {},
): RecipeCandidate {
  return {
    id,
    title: extras.title ?? id,
    text: extras.text ?? `${id}:${chunk_id}`,
    kind: extras.kind ?? "page",
    authority: extras.authority ?? "connector_evidence",
    chunk_id,
    keyword_hit: extras.keyword_hit ?? false,
    score: extras.score ?? 1,
    vector: extras.vector ?? null,
  };
}

const EDGES: RecipeEdge[] = [
  { from: "a", to: "b", type: "link", weight: 1, provenance: ["p1"] },
  { from: "b", to: "c", type: "link", weight: 1, provenance: ["p2"] },
];

describe("retrieval recipe audit regressions", () => {
  test("two-hop walks emit each stored edge once", () => {
    const walked = walkNeighbors("a", EDGES, {
      hops: 2,
      limit: 10,
      visible: () => true,
    });
    expect(walked.edges).toEqual(EDGES);
    expect(walked.truncated).toBe(false);
  });

  test("a walk exactly at its limit is not reported as truncated", () => {
    const exact = walkNeighbors("a", [EDGES[0]!], {
      hops: 1,
      limit: 1,
      visible: () => true,
    });
    expect(exact.edges).toHaveLength(1);
    expect(exact.truncated).toBe(false);

    const clipped = walkNeighbors("b", EDGES, {
      hops: 1,
      limit: 1,
      visible: () => true,
    });
    expect(clipped.edges).toHaveLength(1);
    expect(clipped.truncated).toBe(true);
  });

  test("frontier-cap truncation survives edge de-duplication", () => {
    const edges = Array.from({ length: NEIGHBOR_CAP_PER_HOP + 1 }, (_, i) => ({
      from: "hub",
      to: `n${i}`,
      type: "link",
      weight: 1,
      provenance: [`p${i}`],
    }));
    expect(
      walkNeighbors("hub", edges, {
        hops: 1,
        limit: 1_000,
        visible: () => true,
      }).truncated,
    ).toBe(false);
    expect(
      walkNeighbors("hub", edges, {
        hops: 2,
        limit: 1_000,
        visible: () => true,
      }).truncated,
    ).toBe(true);
  });

  test("duplicate chunks do not masquerade as distinct adjacent documents", () => {
    const boosted = applyAdjacencyBoost(
      [
        { id: "a", score: 1 },
        { id: "b", score: 0.9 },
        { id: "b", score: 0.8 },
      ],
      [EDGES[0]!],
      () => true,
    );
    expect(boosted[0]?.score).toBe(1);
  });

  test("RRF keeps the vector-bearing form of a shared lexical/vector chunk", () => {
    const vector = new Float32Array([1, 0]);
    const fused = rrfFusion([
      [candidate("a", 0, { keyword_hit: true, text: "whole document" })],
      [candidate("a", 0, { vector, text: "matching chunk" })],
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.vector).toEqual(vector);
    expect(fused[0]?.text).toBe("matching chunk");
    expect(fused[0]?.keyword_hit).toBe(true);
  });

  test("duplicate chunks do not consume document-kind diversity slots", () => {
    const result = finalizeRecipe({
      lexical: [
        candidate("a", 0, { text: "a top" }),
        candidate("b", 0),
        candidate("c", 0),
        candidate("d", 0),
        candidate("a", 1, { text: "a low" }),
        candidate("x", 0, { kind: "claim" }),
      ],
      vector: null,
      queryVector: null,
      edges: [
        { from: "a", to: "b", type: "link", weight: 1, provenance: ["p1"] },
        { from: "a", to: "c", type: "link", weight: 1, provenance: ["p2"] },
      ],
      visible: () => true,
    });
    expect(result.map((row) => row.id)).toContain("d");
    expect(result).toHaveLength(5);
  });
});
