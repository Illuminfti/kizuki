import { expect, test } from "bun:test";
import { responsePacer, RESPONSE_GAP_MS } from "./pacing";
import { runQualification } from "./run";
import { startFakeEndpoint } from "../../packages/llm/test/fake-endpoint";
import { validateResume } from "./resume";
import { qualificationCorpus } from "./corpus";
import { candidateRegistry, registryDigest } from "./registry";
import { WORLD_VOCABULARY_MODULES } from "./candidate-modules";
import { caseInput, scoreRun, type Observation } from "./score";
import { extractionV2SystemContent } from "../../packages/core/src/producer/prompt-v2";
import { sha256 } from "../evaluate-extraction";

function fixture() {
  const registry = candidateRegistry(WORLD_VOCABULARY_MODULES, ["concept"]);
  const selected = qualificationCorpus.cases.filter(row => row.kind === "concept");
  const promptByCase = Object.fromEntries(selected.map(item => [item.id, sha256(extractionV2SystemContent(caseInput(item, registry)))]));
  const observations: Observation[] = selected.slice(0, 2).map((item, index) => ({ case_id: item.id, input: caseInput(item, registry), status: index === 0 ? "ok" : "unavailable",
    response: index === 0 ? { schema: "kizuki.producer-response/v2", mentions: [], claims: [] } : null, dropped: 0, usage: { calls: 1, input_tokens: index === 0 ? 100 : 0, output_tokens: index === 0 ? 10 : 0 } }));
  const tuple = { selected_kinds: ["concept"], selected_extensions: [], selected_cases: selected.map(row => row.id), model: "synthetic-control", endpoint_host: "127.0.0.1:1", registry_sha256: registryDigest(registry), prompt_sha256_by_case: promptByCase };
  const prior = { ...tuple, schema: "kizuki.world-qualification-run/v1", evidence: "runner_observed_transport", synthetic: true, source_clean: true,
    source_commit: "a".repeat(40), runner_sha256: "b".repeat(64), missing: [], corpus: qualificationCorpus, observations, score: scoreRun(qualificationCorpus, observations),
    traces: observations.map((row, index) => ({ case_id: row.case_id, prompt_sha256: promptByCase[row.case_id], request_sha256: "c".repeat(64), response_sha256: index === 0 ? "d".repeat(64) : sha256("http:429"),
      transport: index === 0 ? "ok" : "failed", started_at: new Date(index * 60_000).toISOString(), completed_at: new Date(index * 60_000 + 1000).toISOString() })) };
  const bytes = JSON.stringify(prior), pin = { sha256: sha256(bytes), source_commit: prior.source_commit, runner_sha256: prior.runner_sha256 };
  return { registry, tuple, prior, evidence: { sha256: pin.sha256, bytes }, pin };
}

test("delayed admission cannot outrun a 61-second gap measured from response completion", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const pacer = responsePacer({ now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; } });
  expect(await pacer.ready()).toBe(true);
  const firstClientStart = now, serverAdmission = firstClientStart + 57;
  expect(firstClientStart + 60_000 - serverAdmission).toBeLessThan(60_000); // Original defect.
  now = 20_000; const responseEnd = now; pacer.completed();
  await pacer.ready();
  expect(now - responseEnd).toBe(RESPONSE_GAP_MS);
  expect(now - serverAdmission).toBeGreaterThan(60_000);
  expect(Math.max(...sleeps)).toBeLessThanOrEqual(1000);
  now += 80_000; pacer.completed(); const secondEnd = now;
  await pacer.ready(); expect(now - secondEnd).toBe(RESPONSE_GAP_MS);
});

test("stop during pacing prevents a request and initial persisted completion still imposes a gap", async () => {
  let now = 0, stopped = false;
  const pacer = responsePacer({ now: () => now, sleep: async ms => { now += ms; stopped = true; } }, RESPONSE_GAP_MS);
  expect(await pacer.ready(() => stopped)).toBe(false);
  expect(now).toBe(1000);
});

test("exact predecessor preserves semantically failing successful responses and only retries HTTP429", () => {
  const f = fixture();
  const resumed = validateResume(f.evidence, f.tuple, f.registry, [f.pin]);
  expect(f.prior.score.kinds.find(row => row.kind === "concept")?.status).toBe("failed");
  expect(resumed.observations).toEqual([f.prior.observations[0]!]);
  expect(resumed.retry).toEqual([f.prior.observations[1]!.case_id]);
  expect(resumed.traces[0]!.http_status).toBeNull(); // v1 did not record exact status.
  expect(resumed.attempts).toBe(2);
  expect(() => validateResume(f.evidence, f.tuple, f.registry)).toThrow("pin mismatch");
  expect(() => validateResume({ ...f.evidence, bytes: f.evidence.bytes + " " }, f.tuple, f.registry, [f.pin])).toThrow("pin mismatch");
  for (const tuple of [{ ...f.tuple, model: "different" }, { ...f.tuple, endpoint_host: "elsewhere" }, { ...f.tuple, registry_sha256: "d".repeat(64) }, { ...f.tuple, prompt_sha256_by_case: {} }, { ...f.tuple, selected_cases: [] }])
    expect(() => validateResume(f.evidence, tuple, f.registry, [f.pin])).toThrow();
});

test("even freshly pinned malformed predecessor provenance, pending turns or unreviewed failures cannot resume", () => {
  const f = fixture();
  for (const prior of [{ ...f.prior, source_clean: false }, { ...f.prior, source_commit: "e".repeat(40) }, { ...f.prior, runner_sha256: "e".repeat(64) },
    { ...f.prior, traces: f.prior.traces.map(row => ({ ...row, completed_at: null })) },
    { ...f.prior, traces: f.prior.traces.map(row => ({ ...row, transport: "failed", response_sha256: sha256("http:503") })) },
    { ...f.prior, observations: [...f.prior.observations, f.prior.observations[0]] }]) {
    const bytes = JSON.stringify(prior), sha = sha256(bytes);
    expect(() => validateResume({ bytes, sha256: sha }, f.tuple, f.registry, [{ ...f.pin, sha256: sha }])).toThrow();
  }
});

test("a diagnostic case subset preserves the offered registry without qualifying omitted kinds", async () => {
  const server = startFakeEndpoint(() => new Response("synthetic rate refusal", { status: 429 }));
  try {
    const kinds = ["concept", "situation"];
    const registry = candidateRegistry(WORLD_VOCABULARY_MODULES, kinds);
    const result = await runQualification({ kinds, base_url: server.base_url, model: "synthetic", case_ids: ["c-shelter-effect"] });
    expect(result.missing).toEqual([]);
    expect(result.registry_sha256).toBe(registryDigest(registry));
    expect(result.selected_kinds).toEqual(kinds);
    expect(result.selected_cases).toEqual(["c-shelter-effect"]);
    expect(server.requests).toHaveLength(1);
    expect(result.halt_reason).toBe("transport_refused");
    for (const kind of ["situation"]) expect(result.score.kinds.find(row => row.kind === kind)?.status).toBe("not_run");
  } finally { server.stop(); }
});

test("HTTP429 records explicit transport failure, halts without retries, and leaves remaining cases not_run", async () => {
  const server = startFakeEndpoint(() => new Response("synthetic rate refusal", { status: 429 }));
  try {
    const result = await runQualification({ kinds: ["concept"], base_url: server.base_url, model: "synthetic", case_ids: ["c-shelter-effect", "c-template-only"] });
    expect(server.requests).toHaveLength(1);
    expect(result.traces[0]?.http_status).toBe(429);
    expect(result.halt_reason).toBe("transport_refused");
    expect(result.score.kinds.find(row => row.kind === "concept")?.status).toBe("not_run");
    expect(result.case_states).toEqual([{ case_id: "c-shelter-effect", status: "transport_failed" }, { case_id: "c-template-only", status: "not_run" }]);
    expect(result.observations).toHaveLength(1);
  } finally { server.stop(); }
});

test("a requested between-turn stop sends no model request", async () => {
  const server = startFakeEndpoint(() => { throw new Error("unexpected request"); });
  try {
    const result = await runQualification({ kinds: ["concept"], base_url: server.base_url, model: "synthetic", stopped: () => true });
    expect(server.requests).toHaveLength(0); expect(result.halt_reason).toBe("requested_stop");
    expect(result.case_states.every(row => row.status === "not_run")).toBe(true);
  } finally { server.stop(); }
});


test("stop during an active HTTP turn preserves its response before stopping the next request", async () => {
  let stopped = false;
  const server = startFakeEndpoint(async () => {
    stopped = true; await Bun.sleep(20);
    return Response.json({ id: "stop-control", model: "synthetic", object: "chat.completion", created: 1,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ schema: "kizuki.producer-response/v2", mentions: [], claims: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  });
  try {
    const result = await runQualification({ kinds: ["concept"], base_url: server.base_url, model: "synthetic", stopped: () => stopped, case_ids: ["c-shelter-effect", "c-template-only"] });
    expect(server.requests).toHaveLength(1); expect(result.halt_reason).toBe("requested_stop");
    expect(result.traces[0]?.http_status).toBe(200); expect(result.traces[0]?.completed_at).not.toBeNull();
    expect(result.observations).toHaveLength(1); expect(result.observations[0]?.response?.schema).toBe("kizuki.producer-response/v2");
    expect(result.case_states[1]?.status).toBe("not_run");
  } finally { server.stop(); }
});
