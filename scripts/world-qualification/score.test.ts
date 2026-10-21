import { expect, test } from "bun:test";
import { qualificationCorpus } from "./corpus";
import { caseInput, scoreCase, scoreRun, type Observation, type QualificationCase } from "./score";
import { candidateRegistry, checkOfferedQualification, registryDigest, verifyQualificationReceipt } from "./registry";
import { WORLD_REGISTRY, WORLD_VOCABULARY_MODULES } from "../../packages/core/src/contracts/world-vocabulary";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import type { ExtractResponseV2, DraftRef, TextAnchor } from "../../packages/core/src/contracts/producer-v2";
import { runQualification } from "./run";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startFakeEndpoint } from "../../packages/llm/test/fake-endpoint";
import type { WorldRegistry } from "../../packages/core/src/contracts/world-kinds";
import { RUNNER_FILES, SOURCE_FILES, runnerDigest, sourceProvenance } from "./fingerprint";
import { extractionV2SystemContent } from "../../packages/core/src/producer/prompt-v2";

/** A scorer control only. It never receives runner provenance or enables product flags. */
export function scripted(item: QualificationCase, registry?: WorldRegistry): Observation {
  const input = caseInput(item, registry ?? candidateRegistry(WORLD_VOCABULARY_MODULES, [item.kind]));
  const mentions: ExtractResponseV2["mentions"][number][] = [];
  const refs = new Map<string, DraftRef>();
  const ref = (value: string | null): DraftRef | null => {
    if (value === null) return null;
    if (value.startsWith("supplied:")) return { kind: "supplied", id: value.slice(9) };
    if (refs.has(value)) return refs.get(value)!;
    const [, recordId, start, end] = value.split(":"), index = item.records.findIndex(row => row.id === recordId), event = input.events[index]!;
    const id = `m${mentions.length + 1}`, anchor = { event_id: event.event_id, start_utf16: Number(start), end_utf16: Number(end) };
    const nominated = item.nominations?.find(row => row.mention === value)?.supplied;
    mentions.push({ id, label: event.text.slice(anchor.start_utf16, anchor.end_utf16), anchor,
      candidate_refs: nominated === undefined ? [] : [{ kind: "supplied", id: nominated }] });
    const result = { kind: "mention" as const, id }; refs.set(value, result); return result;
  };
  const anchors = (values: (DraftRef | null)[], citations: string[]): TextAnchor[] => {
    const result = citations.map(id => { const index = item.records.findIndex(row => row.id === id), event = input.events[index]!; return { event_id: event.event_id, start_utf16: 0, end_utf16: event.text.length }; });
    const cited = new Set(result.map(row => row.event_id));
    for (const value of values) if (value !== null) result.push(...(value.kind === "supplied" ? input.supplied_refs.find(row => row.id === value.id)!.anchors.filter(row => cited.has(row.event_id)) : [mentions.find(row => row.id === value.id)!.anchor]));
    return [...new Map(result.map(row => [canonicalJson(row), row])).values()];
  };
  const claims = item.required.map((alternatives, index) => {
    const row = alternatives[0]!, subject = ref(row.subject)!, context = row.context.map(value => ref(value)!);
    const object = row.object.kind === "literal" ? { kind: "literal" as const, value: row.object.value } : row.object.kind === "vocabulary"
      ? { kind: "vocabulary" as const, ref: { kind: "vocabulary" as const, id: row.object.value } } : { kind: "subject" as const, ref: ref(row.object.value)! };
    const holder = ref(row.holder), speaker = ref(row.speaker), addressee = ref(row.addressee);
    return { id: `c${index + 1}`, subject, predicate: row.predicate, object, perspective: { holder, speaker, addressee, mode: row.mode, interpretation: row.interpretation,
      anchors: anchors([holder, speaker, addressee], row.perspective_citations) }, context, polarity: row.polarity, body: "Synthetic scorer control.",
      valid_from: row.valid_from, valid_to: row.valid_to, temporal_basis: row.temporal_basis, confidence: 0.8, sensitivity: "personal" as const,
      anchors: anchors([subject, ...(object.kind === "subject" ? [object.ref] : []), ...context], row.citations) };
  });
  return { case_id: item.id, input, status: "ok", response: { schema: "kizuki.producer-response/v2", mentions, claims }, dropped: 0, usage: { calls: 1, input_tokens: 10, output_tokens: 10 } };
}

test("missing observations are not_run and never a qualified kind", () => {
  const report = scoreRun(qualificationCorpus, []);
  expect(report.status).toBe("not_run");
  expect(report.kinds.every(row => row.status === "not_run")).toBe(true);
});

test("all runnable authored cases have satisfiable typed oracles, without claiming model quality", () => {
  for (const item of qualificationCorpus.cases.filter(row => ["concept", "situation", "question"].includes(row.kind))) {
    if (item.required.flat().some(row => !WORLD_REGISTRY.vocabulary.some(predicate => predicate.predicate === row.predicate))) continue;
    const result = scoreCase(item, scripted(item));
    expect({ id: result.id, errors: result.errors }).toEqual({ id: item.id, errors: [] });
  }
});

test("attribution swaps, invented dates, unsupported claims and dropped output all fail", () => {
  const item = qualificationCorpus.cases.find(row => row.id === "question-perspective-v1")!;
  const good = scripted(item);
  expect(scoreCase(item, good).passed).toBe(true);
  const first = good.response!.claims[0]!;
  for (const replacement of [
    { ...first, perspective: { ...first.perspective, holder: { kind: "supplied" as const, id: "ben" } } },
    { ...first, perspective: { ...first.perspective, mode: "asserted" as const } },
    { ...first, valid_from: "2026-01-01T00:00:00Z", temporal_basis: "explicit" as const },
    { ...first, object: { kind: "vocabulary" as const, ref: { kind: "vocabulary" as const, id: "question/resolved" } }, predicate: "question.status" },
  ]) expect(scoreCase(item, { ...good, response: { ...good.response!, claims: [replacement, ...good.response!.claims.slice(1)] } }).passed).toBe(false);
  expect(scoreCase(item, { ...good, dropped: 1 }).passed).toBe(false);
  expect(scoreCase(item, { ...good, usage: { ...good.usage, output_tokens: null } }).passed).toBe(false);
  expect(scoreCase(item, { ...good, response: { ...good.response!, claims: [...good.response!.claims, first] } }).passed).toBe(false);
});

test("grounding requires exact witness nominations and cannot count context as independent testimony", () => {
  const item = qualificationCorpus.cases.find(row => row.id === "concept-grounding-compatible-v1")!;
  const good = scripted(item);
  expect(scoreCase(item, good).errors).toEqual([]);
  const [left, right] = good.response!.mentions;
  expect(() => {
    const swapped = { ...good, response: { ...good.response!, mentions: [{ ...left!, candidate_refs: right!.candidate_refs }, right!] } };
    expect(scoreCase(item, swapped).errors).toContain("incorrect_nomination");
  }).not.toThrow();
  const unbound = { ...good, response: { ...good.response!, mentions: good.response!.mentions.map(row => ({ ...row, candidate_refs: [] })) } };
  expect(scoreCase(item, unbound).errors).toContain("incorrect_nomination");
  const extraContext = { event_id: good.input.events[0]!.event_id, start_utf16: 0, end_utf16: good.input.events[0]!.text.length };
  const copied = { ...good, response: { ...good.response!, claims: good.response!.claims.map(row => ({ ...row, anchors: [...row.anchors, extraContext] })) } };
  expect(scoreCase(item, copied).passed).toBe(false);
  for (const id of ["concept-grounding-homonym-v1", "concept-grounding-missing-proof-v1", "concept-grounding-quoted-labels-v1"]) {
    const abstention = qualificationCorpus.cases.find(row => row.id === id)!;
    expect(scoreCase(abstention, scripted(abstention)).passed).toBe(true);
  }
});

test("grounding cases reach the actual conditional prompt and ProducerV2 parser", async () => {
  const item = qualificationCorpus.cases.find(row => row.id === "concept-grounding-compatible-v1")!;
  const control = scripted(item);
  const server = startFakeEndpoint(() => Response.json({ id: "grounding-control", model: "synthetic", object: "chat.completion", created: 1,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(control.response) } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  try {
    const result = await runQualification({ kinds: ["concept"], base_url: server.base_url, model: "synthetic", case_ids: [item.id] });
    expect(result.observations).toHaveLength(1);
    expect(scoreCase(item, result.observations[0]!).errors).toEqual([]);
    const body = server.requests[0]!.body as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toContain("Identity grounding:");
    expect(result.traces[0]!.prompt_sha256).toBe(sha256(body.messages[0]!.content));
    expect(result.prompt_sha256_by_case[item.id]).toBe(result.traces[0]!.prompt_sha256);
    expect(result.score.kinds.find(row => row.kind === "concept")?.status).toBe("failed");
  } finally { server.stop(); }
});

test("response files cannot self-attest observed provider provenance or become reviewed qualifications", () => {
  const fake = JSON.stringify({ schema: "kizuki.world-qualification-run/v1", evidence: "scripted_contract", synthetic: true });
  expect(() => verifyQualificationReceipt(fake, { file: "fake.json", sha256: sha256(fake), endpoint_evidence: "a".repeat(64) }, WORLD_REGISTRY)).toThrow();
  const candidate = candidateRegistry(WORLD_VOCABULARY_MODULES, ["question"]);
  expect(() => checkOfferedQualification(candidate, [{ registry_sha256: "a".repeat(64), report_sha256: "b".repeat(64), kinds: ["question"], predicates: candidate.offered.vocabulary.map(row => row.predicate) }])).toThrow();
});

test("a clean surrounding Git commit cannot attest an untracked or modified runner", () => {
  const directory = mkdtempSync(join(tmpdir(), "qualification-source-"));
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", directory, ...args]);
  try {
    expect(git("init").exitCode).toBe(0);
    expect(git("-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.test", "commit", "--allow-empty", "-m", "Initialize synthetic provenance fixture").exitCode).toBe(0);
    for (const path of SOURCE_FILES) { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), "synthetic\n"); }
    expect(sourceProvenance(directory).source_clean).toBe(false);
    expect(git("add", "--", ...SOURCE_FILES).exitCode).toBe(0);
    expect(sourceProvenance(directory).source_clean).toBe(false);
    expect(git("-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.test", "commit", "-m", "Track synthetic provenance fixture").exitCode).toBe(0);
    expect(sourceProvenance(directory).source_clean).toBe(true);
    const digest = runnerDigest(directory);
    writeFileSync(join(directory, "scripts/world-qualification/approvals.ts"), "synthetic reviewed report and provider pins\n");
    expect(runnerDigest(directory)).toBe(digest);
    writeFileSync(join(directory, "scripts/world-qualification/registry.ts"), "changed verifier\n");
    expect(runnerDigest(directory)).not.toBe(digest);
    writeFileSync(join(directory, "scripts/world-qualification/registry.ts"), "synthetic\n");
    writeFileSync(join(directory, "scripts/world-qualification/score.ts"), "changed scorer\n");
    expect(runnerDigest(directory)).not.toBe(digest);
    writeFileSync(join(directory, RUNNER_FILES[0]), "changed\n");
    expect(sourceProvenance(directory).source_clean).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the receipt verifier binds reviewed bytes, full cases, prompt, source and transport pacing", () => {
  // Deliberately fabricated verifier control, never a real provider receipt or an entry in REVIEWED_QUALIFICATIONS.
  const registry = candidateRegistry(WORLD_VOCABULARY_MODULES, ["question"]);
  const observations = qualificationCorpus.cases.filter(row => row.kind === "question").map(item => scripted(item, registry));
  const control = { schema: "kizuki.world-qualification-run/v1", evidence: "runner_observed_transport", synthetic: true,
    source_clean: true, source_commit: "a".repeat(40), runner_sha256: runnerDigest(), registry_sha256: registryDigest(registry),
    prompt_sha256: sha256(extractionV2SystemContent(observations[0]!.input)), missing: [], model: "synthetic-verifier-control", endpoint_host: "127.0.0.1:1",
    selected_kinds: ["question"], selected_extensions: [], corpus: qualificationCorpus, observations, score: scoreRun(qualificationCorpus, observations),
    prompt_sha256_by_case: Object.fromEntries(observations.map(row => [row.case_id, sha256(extractionV2SystemContent(row.input))])),
    traces: observations.map((row, index) => ({ case_id: row.case_id, prompt_sha256: sha256(extractionV2SystemContent(row.input)), transport: "ok", request_sha256: "a".repeat(64), response_sha256: "b".repeat(64),
      started_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), completed_at: new Date(Date.UTC(2026, 0, 1, 0, index, 1)).toISOString() })) };
  const verify = (value: unknown, pinned?: string) => { const bytes = JSON.stringify(value); return verifyQualificationReceipt(bytes,
    { file: "synthetic-control.json", sha256: pinned ?? sha256(bytes), endpoint_evidence: "c".repeat(64) }, registry); };
  expect(() => checkOfferedQualification(registry, [verify(control)])).not.toThrow();
  const v2 = { ...control, schema: "kizuki.world-qualification-run/v2", resumed_from: null, halt_reason: null, response_gap_ms: 61_000,
    selected_cases: observations.map(row => row.case_id), case_states: observations.map(row => ({ case_id: row.case_id, status: "observed" })), attempts: observations.length,
    traces: control.traces.map((row, index) => ({ ...row, origin: "observed_v2", http_status: 200,
      started_at: new Date(Date.UTC(2026, 0, 1) + index * 62_000).toISOString(), completed_at: new Date(Date.UTC(2026, 0, 1) + index * 62_000 + 1000).toISOString() })) };
  expect(() => checkOfferedQualification(registry, [verify(v2)])).not.toThrow();
  for (const mutation of [{ ...v2, halt_reason: "transport_refused" }, { ...v2, response_gap_ms: 60_000 },
    { ...v2, attempts: observations.length - 1 }, { ...v2, traces: v2.traces.map(row => ({ ...row, origin: "inherited_v1" })) },
    { ...v2, traces: v2.traces.map(row => ({ ...row, http_status: null })) },
    { ...v2, traces: v2.traces.map((row, index) => index === 1 ? { ...row, started_at: new Date(Date.parse(row.started_at) - 1).toISOString() } : row) }]) expect(() => verify(mutation)).toThrow();
  expect(() => verify(control, "d".repeat(64))).toThrow("review pin");
  for (const mutation of [
    { ...control, source_clean: false }, { ...control, prompt_sha256_by_case: {} },
    { ...control, observations: observations.slice(1), score: scoreRun(qualificationCorpus, observations.slice(1)) },
    { ...control, traces: control.traces.map(row => ({ ...row, started_at: control.traces[0]!.started_at })) },
    { ...control, traces: control.traces.slice(1) },
  ]) expect(() => verify(mutation)).toThrow();
});

test("missing model or product module writes an honest not_run receipt and never overwrites an existing artifact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qualification-"));
  try {
    const output = join(directory, "not-run.json");
    const result = await runQualification({ kinds: ["question"], output });
    expect(result.score.status).toBe("not_run"); expect(result.traces).toEqual([]);
    expect(JSON.parse(readFileSync(output, "utf8")).missing).toContain("model_unconfigured");
    await expect(runQualification({ kinds: ["question"], output })).rejects.toThrow();
    const absent = await runQualification({ kinds: ["not_registered"] });
    expect(absent.missing).toContain("not_registered:module_missing");
    expect(absent.score.status).toBe("not_run");
    const sentinel = join(directory, "sentinel.json"); writeFileSync(sentinel, "unchanged");
    await expect(runQualification({ kinds: ["question"], output: sentinel })).rejects.toThrow();
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("actual port observation binds the exact prompt and usage but a single synthetic answer cannot qualify a kind", async () => {
  const server = startFakeEndpoint(() => Response.json({ id: "synthetic-control", model: "synthetic", object: "chat.completion", created: 1,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ schema: "kizuki.producer-response/v2", mentions: [], claims: [] }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  try {
    const result = await runQualification({ kinds: ["question"], base_url: server.base_url, model: "synthetic", case_ids: ["question-abstention-v1"] });
    expect(result.observations).toHaveLength(1); expect(result.traces).toHaveLength(1);
    expect(result.observations[0]!.usage).toEqual({ calls: 1, input_tokens: 100, output_tokens: 10 });
    expect(result.score.kinds.find(row => row.kind === "question")?.status).toBe("failed");
    expect(result.score.kinds.find(row => row.kind === "question")?.cases.find(row => row.family === "abstention")?.passed).toBe(true);
    const body = server.requests[0]!.body as { messages: { role: string; content: string }[]; max_tokens: number };
    expect(result.prompt_sha256).toBe(sha256(body.messages[0]!.content));
    expect(body.messages[1]!.content).not.toContain("required");
    expect(body.messages[1]!.content).not.toContain("candidate_answer");
    expect(body.max_tokens).toBe(8192);
    expect(WORLD_REGISTRY.kind("question")?.offeredToProducer).toBe(false);
  } finally { server.stop(); }
});

test("endpoint and credential custody failures cannot call the model or expose token contents", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qualification-token-"));
  const server = startFakeEndpoint(() => new Response("unexpected", { status: 500 }));
  try {
    await expect(runQualification({ kinds: ["question"], base_url: "https://models.example.test/v1", model: "synthetic" })).rejects.toThrow("endpoint rejected");
    const path = join(directory, "token"); writeFileSync(path, "synthetic-private-marker", { mode: 0o644 });
    await expect(runQualification({ kinds: ["question"], base_url: server.base_url, model: "synthetic", token_file: path, case_ids: ["question-abstention-v1"] })).rejects.toThrow("token custody rejected");
    expect(server.requests).toHaveLength(0);
  } finally { server.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test("a candidate registry changes only isolated offered flags and fails the production gate without reviewed evidence", () => {
  const before = JSON.stringify(WORLD_REGISTRY.offered);
  const candidate = candidateRegistry(WORLD_VOCABULARY_MODULES, ["question"]);
  expect(candidate.kind("question")?.offeredToProducer).toBe(true);
  expect(JSON.stringify(WORLD_REGISTRY.offered)).toBe(before);
  expect(() => checkOfferedQualification(candidate, [])).toThrow("unqualified offered vocabulary");
  expect(() => checkOfferedQualification(WORLD_REGISTRY, [])).not.toThrow();
});

test("an empty successful response proves abstention only; it cannot qualify positive, perspective or time cases", () => {
  const empty = { schema: "kizuki.producer-response/v2" as const, mentions: [], claims: [] };
  for (const item of qualificationCorpus.cases.filter(row => row.kind === "question")) {
    const input = caseInput(item, candidateRegistry(WORLD_VOCABULARY_MODULES, ["question"]));
    const score = scoreCase(item, { case_id: item.id, input, status: "ok", response: empty, dropped: 0, usage: { calls: 1, input_tokens: 10, output_tokens: 10 } });
    expect(score.passed).toBe(item.family === "abstention");
  }
});
