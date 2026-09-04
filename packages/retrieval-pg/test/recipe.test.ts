import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEIGHBOR_CAP_PER_HOP } from "../vendor/recipe/graph";
import {
  AUTHORITY_WEIGHT,
  NEAR_DUPLICATE_JACCARD,
  RRF_K,
  collapseToDocuments,
  cosineReScore,
  cosineSimilarity,
  dedupResults,
  pushDegraded,
  rrfFusion,
  walkNeighbors,
} from "../vendor/recipe";
import type { RecipeCandidate } from "../vendor/recipe";
import {
  candidateFromDoc,
  finalizeRecipe,
  hitsFromCandidates,
} from "../src/rank";
import type { RetrievalDoc } from "@kizuki/core";

const VENDOR = join(import.meta.dir, "../vendor");

function candidate(
  id: string,
  score: number,
  extras: Partial<RecipeCandidate> = {},
): RecipeCandidate {
  return {
    id,
    title: extras.title ?? id,
    text: extras.text ?? id,
    kind: extras.kind ?? "page",
    authority: extras.authority ?? "connector_evidence",
    chunk_id: extras.chunk_id ?? 0,
    keyword_hit: extras.keyword_hit ?? false,
    score,
    vector: extras.vector ?? null,
  };
}

const BASE_DOC: RetrievalDoc = {
  doc_id: "page:alpha",
  kind: "page",
  title: "Alpha",
  text: "alpha body",
  sensitivity: "personal",
  taint: "clean",
  authority: "connector_evidence",
  subjects: ["person:alpha"],
  provenance: ["event:alpha"],
  occurred_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-09-02T12:00:00.000Z",
};

describe("vendored retrieval recipe", () => {
  test("NOTICE pins the public tip and LICENSE retains the copyright", () => {
    const license = readFileSync(join(VENDOR, "LICENSE"), "utf8");
    const notice = readFileSync(join(VENDOR, "NOTICE"), "utf8");
    expect(license).toContain("Copyright (c) 2026 Garry Tan");
    expect(license).toContain("MIT License");
    expect(notice).toContain("8c70f6255047a7647adb30b1d6333a48068d9fa5");
    expect(notice).toContain("0.48.2.0");
    expect(notice).toContain("2026-09-04");
  });

  test("RRF uses k=60 and normalizes before the authority boost", () => {
    expect(RRF_K).toBe(60);
    const lexical = [candidate("page:a", 1), candidate("page:b", 0.5)];
    const vector = [candidate("page:b", 1), candidate("page:a", 0.5)];
    const fused = rrfFusion([lexical, vector], RRF_K, true);
    expect(fused.map((row) => row.id).sort()).toEqual(["page:a", "page:b"]);
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? 0, 8);
    const raw = rrfFusion([lexical, vector], RRF_K, false);
    expect(raw[0]?.score).toBeCloseTo(1, 8);
    expect(raw[1]?.score).toBeCloseTo(1, 8);
    expect(AUTHORITY_WEIGHT.owner_correction).toBe(2.0);
  });

  test("owner_correction outranks a higher raw lexical score", () => {
    const correction = candidateFromDoc(
      { ...BASE_DOC, doc_id: "page:corrected", authority: "owner_correction" },
      1,
      { keyword_hit: true },
    );
    const inferred = candidateFromDoc(
      { ...BASE_DOC, doc_id: "page:inferred", authority: "model_inference" },
      4,
      { keyword_hit: true },
    );
    const fused = finalizeRecipe({
      lexical: [inferred, correction],
      vector: null,
      queryVector: null,
      edges: [],
      visible: () => true,
    });
    expect(fused[0]?.id).toBe("page:corrected");
    expect(fused[0]?.score ?? 0).toBeGreaterThan(fused[1]?.score ?? 0);
  });

  test("layered dedup drops intra-document near-duplicates and keeps distinct pages", () => {
    expect(NEAR_DUPLICATE_JACCARD).toBe(0.85);
    const kept = dedupResults([
      candidate("page:memo", 2, {
        chunk_id: 0,
        text: "weekly report alpha beta gamma",
      }),
      candidate("page:memo", 1.5, {
        chunk_id: 1,
        text: "weekly report alpha beta gamma",
      }),
      candidate("page:other", 1.4, {
        text: "weekly report alpha beta gamma",
      }),
    ]);
    expect(kept.filter((row) => row.id === "page:memo")).toHaveLength(1);
    expect(kept.some((row) => row.id === "page:other")).toBe(true);
  });

  test("cosine re-score blends 0.7 fused + 0.3 vector and does not leave raw scale", () => {
    const query = new Float32Array([1, 0]);
    const aligned = new Float32Array([1, 0]);
    const orthogonal = new Float32Array([0, 1]);
    const rescored = cosineReScore(
      [
        candidate("page:aligned", 2, { vector: aligned }),
        candidate("page:empty", 2, { vector: null }),
        candidate("page:side", 2, { vector: orthogonal }),
      ],
      query,
    );
    expect(rescored[0]?.id).toBe("page:aligned");
    expect(rescored[0]?.score).toBeCloseTo(1, 5);
    expect(rescored.find((row) => row.id === "page:empty")?.score).toBeCloseTo(
      0.7,
      5,
    );
    expect(cosineSimilarity(query, aligned)).toBeCloseTo(1, 8);
  });

  test("fusion keeps a later vector so the cosine blend applies to dual matches", () => {
    const query = new Float32Array([1, 0]);
    const aligned = new Float32Array([1, 0]);
    const fused = rrfFusion(
      [
        [candidate("page:a", 1, { keyword_hit: true })],
        [candidate("page:a", 1, { vector: aligned })],
      ],
      RRF_K,
      false,
    );
    expect(fused[0]?.keyword_hit).toBe(true);
    expect(fused[0]?.vector).not.toBeNull();
    const rescored = cosineReScore(fused, query);
    expect(rescored[0]?.score).toBeCloseTo(1, 5);
    const reversed = rrfFusion(
      [
        [candidate("page:a", 1, { vector: aligned })],
        [candidate("page:a", 1, { keyword_hit: true })],
      ],
      RRF_K,
      false,
    );
    expect(reversed[0]?.keyword_hit).toBe(true);
    expect(reversed[0]?.vector).not.toBeNull();
  });

  test("declared degradation is set-like", () => {
    const degraded: string[] = [];
    pushDegraded(degraded, "vector-skipped");
    pushDegraded(degraded, "vector-skipped");
    pushDegraded(degraded, "keyword-zero");
    expect(degraded).toEqual(["vector-skipped", "keyword-zero"]);
  });

  test("graph walk is fail-closed for invisible nodes", () => {
    const walked = walkNeighbors(
      "person:grace",
      [
        {
          from: "page:grace",
          to: "person:grace",
          type: "subject",
          weight: 1,
          provenance: ["event:a"],
        },
        {
          from: "page:secret",
          to: "person:grace",
          type: "subject",
          weight: 1,
          provenance: ["event:b"],
        },
      ],
      {
        hops: 1,
        limit: 10,
        visible: (id) => id !== "page:secret",
      },
    );
    expect(walked.edges.map((edge) => edge.from)).toEqual(["page:grace"]);
    expect(walked.truncated).toBe(false);
  });

  test("two-hop walk does not echo the inbound edge or false-truncate", () => {
    const edges = [
      {
        from: "page:a",
        to: "person:hub",
        type: "subject",
        weight: 1,
        provenance: ["event:a"],
      },
      {
        from: "page:b",
        to: "person:hub",
        type: "subject",
        weight: 1,
        provenance: ["event:b"],
      },
      {
        from: "page:c",
        to: "person:hub",
        type: "subject",
        weight: 1,
        provenance: ["event:c"],
      },
    ];
    const walked = walkNeighbors("person:hub", edges, {
      hops: 2,
      limit: 4,
      visible: () => true,
    });
    expect(walked.edges).toHaveLength(3);
    expect(walked.truncated).toBe(false);
    expect(
      new Set(walked.edges.map((edge) => `${edge.from}->${edge.to}:${edge.type}`))
        .size,
    ).toBe(3);
  });

  test("hop-cap truncation is declared when a later hop cannot expand", () => {
    const edges = Array.from({ length: NEIGHBOR_CAP_PER_HOP + 1 }, (_, i) => ({
      from: "person:hub",
      to: `page:n${i}`,
      type: "subject",
      weight: 1,
      provenance: ["event:a"],
    }));
    const oneHop = walkNeighbors("person:hub", edges, {
      hops: 1,
      limit: 1000,
      visible: () => true,
    });
    expect(oneHop.truncated).toBe(false);
    expect(oneHop.edges).toHaveLength(NEIGHBOR_CAP_PER_HOP + 1);
    const twoHop = walkNeighbors("person:hub", edges, {
      hops: 2,
      limit: 1000,
      visible: () => true,
    });
    expect(twoHop.truncated).toBe(true);
  });

  test("adjacency boost keeps candidate fields", () => {
    const fused = finalizeRecipe({
      lexical: [
        candidate("page:a", 1, { keyword_hit: true, text: "hub a" }),
        candidate("page:b", 1, { keyword_hit: true, text: "hub b" }),
        candidate("page:c", 1, { keyword_hit: true, text: "hub c" }),
      ],
      vector: null,
      queryVector: null,
      edges: [
        {
          from: "page:a",
          to: "page:b",
          type: "subject",
          weight: 1,
          provenance: ["event:a"],
        },
        {
          from: "page:a",
          to: "page:c",
          type: "subject",
          weight: 1,
          provenance: ["event:a"],
        },
        {
          from: "page:b",
          to: "page:c",
          type: "subject",
          weight: 1,
          provenance: ["event:a"],
        },
      ],
      visible: () => true,
    });
    expect(fused).toHaveLength(3);
    for (const row of fused) {
      expect(row.keyword_hit).toBe(true);
      expect(row.text.startsWith("hub ")).toBe(true);
    }
  });

  test("hits apply authority before the limit cut", () => {
    const docs = new Map<string, RetrievalDoc>([
      [
        "page:inferred",
        { ...BASE_DOC, doc_id: "page:inferred", authority: "model_inference" },
      ],
      [
        "page:corrected",
        { ...BASE_DOC, doc_id: "page:corrected", authority: "owner_correction" },
      ],
    ]);
    const hits = hitsFromCandidates(
      [candidate("page:inferred", 1), candidate("page:corrected", 1)],
      docs,
      "alpha",
      1,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.doc_id).toBe("page:corrected");
  });

  test("collapse keeps the best chunk per document", () => {
    const collapsed = collapseToDocuments([
      candidate("page:a", 0.4, { chunk_id: 0 }),
      candidate("page:a", 0.9, { chunk_id: 1 }),
      candidate("page:b", 0.5, { chunk_id: 0 }),
    ]);
    expect(collapsed.map((row) => row.id)).toEqual(["page:a", "page:b"]);
    expect(collapsed[0]?.score).toBe(0.9);
  });
});
