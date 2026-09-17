import { describe, expect, test } from "bun:test";
import { PortError } from "../../src/contracts/ports";
import type {
  PortHealth,
  SystemOnePort,
  SystemOneRequest,
  SystemOneResponse,
} from "../../src";
import {
  SYSTEMONE_CONTRACT,
  SYSTEMONE_CONTRACT_MINOR,
  RETRIEVAL_SENSITIVITY_CHOICE_CRITERIA,
  mapSystemOneSensitivityChoice,
  rerankWithSystemOne,
  validateChoiceCriteriaDict,
} from "../../src";
import { validatePortDescriptor } from "../../src/contracts/ports";

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

function scriptedSystemOne(
  script: (request: SystemOneRequest) => SystemOneResponse | Error,
  modelRef: string | null = "kizuki.systemone.jev:jev-latest@127.0.0.1",
): SystemOnePort {
  return {
    descriptor: validatePortDescriptor({
      id: "test.kizuki.systemone.scripted",
      kind: "systemone",
      contract: SYSTEMONE_CONTRACT,
      contract_minor: SYSTEMONE_CONTRACT_MINOR,
      supports: ["evaluate"],
      requires_lease: false,
      optional_package: null,
    }),
    model_ref: modelRef,
    async health(): Promise<PortHealth> {
      return { status: "ready", detail: {} };
    },
    async evaluate(request: SystemOneRequest): Promise<SystemOneResponse> {
      const result = script(request);
      if (result instanceof Error) throw result;
      return result;
    },
    async close() {},
  };
}

function proofAnswers(): SystemOneResponse {
  return {
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
  };
}

describe("retrieval systemone rerank", () => {
  test("noul batch ranking matches the proof order ev1 >> ev3 >> ev2/ev4", async () => {
    let seen: SystemOneRequest | undefined;
    const port = scriptedSystemOne((request) => {
      seen = request;
      return proofAnswers();
    });
    const result = await rerankWithSystemOne({
      query: QUERY,
      candidates: SHORTLIST,
      port,
      deadline_ms: 5_000,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.reranked !== true) return;
    expect(result.ranked.map((hit) => hit.id)).toEqual(["ev1", "ev3", "ev2", "ev4"]);
    expect(result.ranked.map((hit) => hit.noul)).toEqual([0.98, 0.04, 0.02, 0.02]);
    expect(seen?.questions["noul:ev1"]?.type).toBe("noul");
    expect(seen?.questions["noul:ev2"]?.type).toBe("noul");
    expect(seen?.questions["noul:ev3"]?.type).toBe("noul");
    expect(seen?.questions["noul:ev4"]?.type).toBe("noul");
    expect(Object.keys(seen?.questions ?? {}).filter((id) => id.startsWith("noul:"))).toHaveLength(
      4,
    );
  });

  test("choice sensitivity returns sensitive with a probabilities dict", async () => {
    const port = scriptedSystemOne(() => proofAnswers());
    const result = await rerankWithSystemOne({
      query: QUERY,
      candidates: SHORTLIST,
      port,
      deadline_ms: 5_000,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.reranked !== true) return;
    expect(result.sensitivity.choice).toBe("sensitive");
    expect(result.sensitivity.confidence).toBe(0.93);
    expect(result.sensitivity.probabilities).toEqual(SENSITIVE_PROBABILITIES);
    expect(Array.isArray(result.sensitivity.probabilities)).toBe(false);
    expect(result.sensitivity.mapped).toBe("private");
    expect(result.served.map((hit) => hit.id)).toEqual(["ev1", "ev3", "ev2", "ev4"]);
  });

  test("choice criteria is a dict on the evaluate request, never an array", async () => {
    let seen: SystemOneRequest | undefined;
    const port = scriptedSystemOne((request) => {
      seen = request;
      return proofAnswers();
    });
    await rerankWithSystemOne({
      query: QUERY,
      candidates: SHORTLIST,
      port,
      deadline_ms: 5_000,
    });
    const criteria = seen?.questions.sensitivity;
    expect(criteria?.type).toBe("choice");
    if (criteria?.type !== "choice") return;
    expect(Array.isArray(criteria.criteria)).toBe(false);
    expect(criteria.criteria).toEqual(RETRIEVAL_SENSITIVITY_CHOICE_CRITERIA);
    expect(Object.keys(criteria.criteria).sort()).toEqual(
      ["personal", "public", "secret", "sensitive"].sort(),
    );
  });

  test("choice criteria rejected when the shape is an array", () => {
    expect(() => validateChoiceCriteriaDict(["secret", "sensitive"])).toThrow(
      "choice criteria must be an object",
    );
    expect(() => validateChoiceCriteriaDict(["secret", "sensitive"])).toThrow(PortError);
    expect(validateChoiceCriteriaDict(RETRIEVAL_SENSITIVITY_CHOICE_CRITERIA)).toEqual(
      RETRIEVAL_SENSITIVITY_CHOICE_CRITERIA,
    );
  });

  test("missing SystemOne preserves shortlist order", async () => {
    const result = await rerankWithSystemOne({
      query: QUERY,
      candidates: SHORTLIST,
      port: undefined,
      deadline_ms: 5_000,
    });
    expect(result).toEqual({
      status: "ok",
      reranked: false,
      ranked: [...SHORTLIST],
      served: [...SHORTLIST],
      sensitivity: null,
    });
  });

  test("unavailable is not a silent empty success", async () => {
    const port = scriptedSystemOne(
      () => new PortError("unavailable", "http 503", true),
    );
    const result = await rerankWithSystemOne({
      query: QUERY,
      candidates: SHORTLIST,
      port,
      deadline_ms: 5_000,
    });
    expect(result).toEqual({ status: "unavailable", reason: "http 503" });
    expect(result).not.toMatchObject({ status: "ok" });
  });

  test("secret and unlabeled choices are never served", async () => {
    const port = scriptedSystemOne(() => ({
      model: "jev-latest",
      answers: {
        "noul:ev1": { type: "noul", noul: 0.98 },
        "noul:ev2": { type: "noul", noul: 0.02 },
        "noul:ev3": { type: "noul", noul: 0.04 },
        "noul:ev4": { type: "noul", noul: 0.02 },
        sensitivity: {
          type: "choice",
          choice: "secret",
          confidence: 0.91,
          probabilities: {
            secret: 0.91,
            sensitive: 0.05,
            public: 0.02,
            personal: 0.02,
          },
        },
      },
      usage: { input_tokens: 8, output_tokens: 2 },
    }));
    const result = await rerankWithSystemOne({
      query: QUERY,
      candidates: SHORTLIST,
      port,
      deadline_ms: 5_000,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.reranked !== true) return;
    expect(result.sensitivity.mapped).toBeNull();
    expect(result.served).toEqual([]);
    expect(result.ranked.map((hit) => hit.id)).toEqual(["ev1", "ev3", "ev2", "ev4"]);
    expect(mapSystemOneSensitivityChoice("secret")).toBeNull();
    expect(mapSystemOneSensitivityChoice("unknown")).toBeNull();
  });
});
