import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCorpus } from "./evaluate-extraction";
import { referenceSubject, runModelEvaluation, toScorerShape } from "./evaluate-extraction-model";
import type { ExtractResponseV2 } from "../packages/core/src/contracts/producer-v2";

const corpus = loadCorpus(join(import.meta.dir, "fixtures/extraction-quality-v1.json"));
const q02 = corpus.cases.find((item) => item.id === "q02")!;

describe("model evaluation runner", () => {
  test("a remote endpoint is refused unless the caller names it, before any call is made", async () => {
    await expect(runModelEvaluation({ base_url: "https://models.example.test/v1", model: "synthetic" })).rejects.toThrow("--allow-remote");
  });

  test("a loopback run sends only the configured sampling keys, labels the score as a fixture measurement and makes no quality claim", async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      bodies.push(await request.json() as Record<string, unknown>);
      return Response.json({ id: "c", object: "chat.completion", created: 1, model: "synthetic", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ schema: "kizuki.producer-response/v2", mentions: [], claims: [] }) } }] });
    } });
    try {
      const base_url = `http://127.0.0.1:${server.port}/v1`;
      const report = await runModelEvaluation({ base_url, model: "synthetic", temperature: 0, json_mode: true });
      expect(report.qualification).toBe("synthetic_fixture_measured");
      expect(report.model_quality_claim).toBe(false);
      expect(report.provenance).toMatchObject({ loopback: true, calls: corpus.cases.length });
      expect(bodies).toHaveLength(corpus.cases.length);
      expect(bodies[0]).toMatchObject({ temperature: 0, response_format: { type: "json_object" } });
      bodies.length = 0;
      await runModelEvaluation({ base_url, model: "synthetic", corpus_path: join(import.meta.dir, "fixtures/extraction-quality-v1.json") });
      expect("temperature" in bodies[0]!).toBe(false);
      expect("response_format" in bodies[0]!).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("a mention names a fixture subject only by that subject's own name", () => {
    expect(referenceSubject(q02, " Noor ")).toBe("quality:noor");
    expect(referenceSubject(q02, "Meadow Studio")).toBe("quality:unresolved");
    expect(referenceSubject(q02, "I")).toBe("quality:unresolved");
  });

  test("a typed response is restated without repair: citations map back, times normalise, unknown subjects stay unresolved", () => {
    const a = "01M3P00000000000000000000A", b = "01M3P00000000000000000000B";
    const ids = new Map([[a, "q02-a"], [b, "q02-b"]]);
    const anchor = (event_id: string, start: number, end: number) => ({ event_id, start_utf16: start, end_utf16: end });
    const response: ExtractResponseV2 = {
      schema: "kizuki.producer-response/v2",
      mentions: [{ id: "m1", label: "Noor", anchor: anchor(a, 0, 4), candidate_refs: [] }, { id: "m2", label: "Meadow Studio", anchor: anchor(a, 17, 30), candidate_refs: [] }],
      claims: [
        { id: "c1", subject: { kind: "mention", id: "m1" }, predicate: "employment.works_at", object: { kind: "literal", value: "Meadow Studio" },
          perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] }, context: [],
          polarity: "positive", body: "Noor worked there.", valid_from: "2026-01-01T00:00:00Z", valid_to: null, temporal_basis: "explicit",
          confidence: 0.9, sensitivity: "private", anchors: [anchor(a, 0, 40), anchor(b, 0, 10)] },
        { id: "c2", subject: { kind: "mention", id: "m2" }, predicate: "employment.works_at", object: { kind: "subject", ref: { kind: "mention", id: "m1" } },
          perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] }, context: [],
          polarity: "negative", body: "b", valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.4, sensitivity: "personal", anchors: [anchor(a, 17, 30)] },
      ],
    };
    const { claims } = toScorerShape(q02, ids, response) as { claims: Record<string, unknown>[] };
    expect(claims[0]).toMatchObject({ subject: "quality:noor", object: "Meadow Studio", valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, event_ids: ["q02-a", "q02-b"] });
    // A subject-kind object is stated by the mention it points at, and an unnamed subject is unresolved.
    expect(claims[1]).toMatchObject({ subject: "quality:unresolved", object: "Noor", polarity: "negative", event_ids: ["q02-a"] });
  });
});
