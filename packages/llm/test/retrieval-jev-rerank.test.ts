import { afterEach, describe, expect, test } from "bun:test";
import {
  PortError,
  RETRIEVAL_SENSITIVITY_CHOICE_CRITERIA,
  rerankWithSystemOne,
  validateChoiceCriteriaDict,
} from "@kizuki/core";
import type { SystemOneRequest } from "@kizuki/core";
import {
  SYSTEMONE_JEV_DESCRIPTOR,
  createSystemOneJevPort,
} from "../src/index";
import { startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";
import { temporaryLlmContext } from "./helpers";

const QUERY = "When is the next netball club?";

const SHORTLIST = [
  { id: "ev1", text: "Autumn clubs: netball Wednesday 15:30 at the school hall." },
  { id: "ev2", text: "Foundation trustee meeting notes." },
  { id: "ev3", text: "Morning school run for the younger child." },
  { id: "ev4", text: "Account statement remaining balance." },
] as const;

const SENSITIVE_PROBABILITIES = {
  secret: 0.02,
  sensitive: 0.93,
  public: 0.02,
  personal: 0.03,
};

function proofBody(): Response {
  return Response.json({
    model: "jev-latest",
    answers: {
      "noul:ev1": { type: "noul", noul: 0.98 },
      "noul:ev2": { type: "noul", noul: 0.02 },
      "noul:ev3": { type: "noul", noul: 0.04 },
      "noul:ev4": { type: "noul", noul: 0.02 },
      sensitivity: {
        type: "choice",
        choice: "sensitive",
        confidence: 0.93,
        probabilities: SENSITIVE_PROBABILITIES,
      },
    },
    usage: { input_tokens: 20, output_tokens: 8 },
  });
}

describe("retrieval jev rerank via fake endpoint", () => {
  let fake: FakeEndpoint | undefined;

  afterEach(() => {
    fake?.stop();
    fake = undefined;
  });

  test("noul batch ranking order matches the proof shape without a live key", async () => {
    fake = startFakeEndpoint(() => proofBody());
    const temporary = temporaryLlmContext(SYSTEMONE_JEV_DESCRIPTOR, {
      base_url: fake.origin + "/v1",
      model: "jev-latest",
      secret_ref: "env:TYPESAFE_API_KEY",
      max_retries: 0,
    });
    try {
      const port = createSystemOneJevPort(temporary.ctx);
      const result = await rerankWithSystemOne({
        query: QUERY,
        candidates: SHORTLIST,
        port,
        deadline_ms: 5_000,
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok" || result.reranked !== true) return;
      expect(result.ranked.map((hit) => hit.id)).toEqual(["ev1", "ev3", "ev2", "ev4"]);
      expect(result.ranked[0]?.noul).toBeGreaterThan(0.9);
      expect(result.ranked[1]?.noul).toBeGreaterThan(result.ranked[2]?.noul ?? 1);
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.path).toBe("/v1/systemone");
      const body = fake.requests[0]?.body as {
        questions?: Record<string, { type?: string; criteria?: unknown }>;
      };
      expect(body.questions?.sensitivity?.type).toBe("choice");
      expect(Array.isArray(body.questions?.sensitivity?.criteria)).toBe(false);
      expect(body.questions?.sensitivity?.criteria).toEqual(
        RETRIEVAL_SENSITIVITY_CHOICE_CRITERIA,
      );
    } finally {
      temporary.cleanup();
    }
  });

  test("choice sensitivity returns sensitive with a probabilities dict", async () => {
    fake = startFakeEndpoint(() => proofBody());
    const temporary = temporaryLlmContext(SYSTEMONE_JEV_DESCRIPTOR, {
      base_url: fake.origin + "/v1",
      max_retries: 0,
    });
    try {
      const port = createSystemOneJevPort(temporary.ctx);
      const result = await rerankWithSystemOne({
        query: QUERY,
        candidates: SHORTLIST,
        port,
        deadline_ms: 5_000,
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok" || result.reranked !== true) return;
      expect(result.sensitivity.choice).toBe("sensitive");
      expect(result.sensitivity.confidence).toBeCloseTo(0.93);
      expect(result.sensitivity.probabilities).toEqual(SENSITIVE_PROBABILITIES);
      expect(result.sensitivity.mapped).toBe("private");
    } finally {
      temporary.cleanup();
    }
  });

  test("choice criteria array is rejected at the jev request boundary", async () => {
    fake = startFakeEndpoint(() => proofBody());
    const temporary = temporaryLlmContext(SYSTEMONE_JEV_DESCRIPTOR, {
      base_url: fake.origin + "/v1",
      max_retries: 0,
    });
    try {
      const port = createSystemOneJevPort(temporary.ctx);
      const request = {
        state: "synthetic capture",
        questions: {
          sensitivity: {
            type: "choice" as const,
            instructions: "Classify sensitivity.",
            criteria: ["secret", "sensitive", "public", "personal"] as unknown as Record<
              string,
              string | null
            >,
          },
        },
        deadline_ms: 5_000,
      } satisfies SystemOneRequest;
      await expect(port.evaluate(request)).rejects.toMatchObject({
        code: "config_invalid",
        message: "choice criteria must be an object",
      });
      expect(fake.requests).toHaveLength(0);
      expect(() =>
        validateChoiceCriteriaDict(["secret", "sensitive", "public", "personal"]),
      ).toThrow(PortError);
    } finally {
      temporary.cleanup();
    }
  });

  test("unavailable jev is not a silent empty success", async () => {
    fake = startFakeEndpoint(() => new Response(null, { status: 503 }));
    const temporary = temporaryLlmContext(SYSTEMONE_JEV_DESCRIPTOR, {
      base_url: fake.origin + "/v1",
      max_retries: 0,
    });
    try {
      const port = createSystemOneJevPort(temporary.ctx);
      const result = await rerankWithSystemOne({
        query: QUERY,
        candidates: SHORTLIST,
        port,
        deadline_ms: 5_000,
      });
      expect(result.status).toBe("unavailable");
      if (result.status !== "unavailable") return;
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result).not.toMatchObject({ ranked: [] });
    } finally {
      temporary.cleanup();
    }
  });
});
