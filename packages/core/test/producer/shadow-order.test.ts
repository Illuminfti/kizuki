import { describe, expect, test } from "bun:test";
import type { SystemOneResponse } from "../../src/contracts/systemone";
import * as producer from "../../src/producer/index";
import {
  reportShadowOrder,
  SHADOW_ORDER_WORKLOAD,
  ShadowOrderError,
} from "../../src/producer/shadow-order";

const BACKEND = "kizuki.systemone.jev";
const MODEL = "fixture-shadow";

function refusal(run: () => unknown): ShadowOrderError {
  try {
    run();
  } catch (error) {
    if (error instanceof ShadowOrderError) return error;
    throw error;
  }
  throw new Error("expected a ShadowOrderError");
}

function response(model: string, scores: Record<string, number>): SystemOneResponse {
  return {
    model,
    answers: Object.fromEntries(
      Object.entries(scores).map(([id, score]) => [
        id,
        {
          type: "score" as const,
          score,
          legend: {},
          probabilities: {},
          confidence: 1,
        },
      ]),
    ),
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

describe("synthetic evidence-candidate shadow order", () => {
  test("an absent response stays unrun and keeps every candidate", () => {
    const report = reportShadowOrder({
      workload: SHADOW_ORDER_WORKLOAD,
      pinned_backend: "unconfigured",
      pinned_model: MODEL,
      candidate_ids: ["cand.b", "cand.a"],
      response: null,
    });
    expect(report).toEqual({
      workload: SHADOW_ORDER_WORKLOAD,
      pinned_backend: "unconfigured",
      pinned_model: MODEL,
      observed_model: "unrun",
      native_order: ["cand.a", "cand.b"],
      shadow_order: null,
      disagreements: [],
      evidence: "retained",
      admission: "unchanged",
      canon: "unchanged",
      sensitivity: "unchanged",
      grants: "unchanged",
      actions: "none",
      upstream_score: "not_inherited",
    });
    expect(JSON.stringify(report)).not.toContain("private-source");
  });

  test("a pinned score response records rank disagreements and drops nothing", () => {
    const report = reportShadowOrder({
      workload: SHADOW_ORDER_WORKLOAD,
      pinned_backend: BACKEND,
      pinned_model: MODEL,
      candidate_ids: ["cand.a", "cand.b"],
      response: response(MODEL, { "cand.a": 0.1, "cand.b": 0.9 }),
    });
    expect(report.observed_model).toBe(MODEL);
    expect(report.pinned_backend).toBe(BACKEND);
    expect(report.native_order).toEqual(["cand.a", "cand.b"]);
    expect(report.shadow_order).toEqual(["cand.b", "cand.a"]);
    expect(report.disagreements).toEqual([
      { id: "cand.a", native_rank: 0, shadow_rank: 1 },
      { id: "cand.b", native_rank: 1, shadow_rank: 0 },
    ]);
    expect(report.evidence).toBe("retained");
    expect(report.admission).toBe("unchanged");
    expect(report.canon).toBe("unchanged");
    expect(report.actions).toBe("none");
    expect(report.upstream_score).toBe("not_inherited");
  });

  test("a different model is refused and not applied", () => {
    const error = refusal(() =>
      reportShadowOrder({
        workload: SHADOW_ORDER_WORKLOAD,
        pinned_backend: BACKEND,
        pinned_model: MODEL,
        candidate_ids: ["cand.a"],
        response: response("other-model", { "cand.a": 1 }),
      }),
    );
    expect(error.code).toBe("model_mismatch");
  });

  test("a missing score is refused rather than invented", () => {
    const error = refusal(() =>
      reportShadowOrder({
        workload: SHADOW_ORDER_WORKLOAD,
        pinned_backend: BACKEND,
        pinned_model: MODEL,
        candidate_ids: ["cand.a", "cand.b"],
        response: response(MODEL, { "cand.a": 0.4 }),
      }),
    );
    expect(error.code).toBe("incomplete");
  });

  test("an unconfigured backend cannot accept a supplied response", () => {
    const error = refusal(() =>
      reportShadowOrder({
        workload: SHADOW_ORDER_WORKLOAD,
        pinned_backend: "unconfigured",
        pinned_model: MODEL,
        candidate_ids: ["cand.a"],
        response: response(MODEL, { "cand.a": 1 }),
      }),
    );
    expect(error.code).toBe("unsupported");
  });

  test("a pinned backend with no response stays unrun", () => {
    const report = reportShadowOrder({
      workload: SHADOW_ORDER_WORKLOAD,
      pinned_backend: BACKEND,
      pinned_model: MODEL,
      candidate_ids: ["cand.b", "cand.a"],
      response: null,
    });
    expect(report.observed_model).toBe("unrun");
    expect(report.shadow_order).toBeNull();
    expect(report.native_order).toEqual(["cand.a", "cand.b"]);
    expect(report.admission).toBe("unchanged");
  });

  test("a non-finite score is refused", () => {
    const error = refusal(() =>
      reportShadowOrder({
        workload: SHADOW_ORDER_WORKLOAD,
        pinned_backend: BACKEND,
        pinned_model: MODEL,
        candidate_ids: ["cand.a"],
        response: response(MODEL, { "cand.a": Number.POSITIVE_INFINITY }),
      }),
    );
    expect(error.code).toBe("incomplete");
  });

  test("the producer barrel does not advertise the shadow report", () => {
    expect("reportShadowOrder" in producer).toBe(false);
  });
});
