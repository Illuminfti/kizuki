import { describe, expect, test } from "bun:test";
import { parseExtractResponseV2, type DraftRef, type ExtractResponseV2, type RichClaimDraft, type TextAnchor } from "../../packages/core/src/contracts/producer-v2";
import { WORLD_VOCABULARY_MODULES } from "./candidate-modules";
import { candidateRegistry, checkOfferedQualification, registryDigest, verifyQualificationReceipt } from "./registry";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import { coreSemanticCaseInput, coreSemanticContract, coreSemanticCorpus, expectedCoreSemanticReview, scoreCoreSemanticRun, validateCoreSemanticAssets, verifyCoreSemanticReview, type CoreSemanticCase } from "./core-semantic";
import type { Observation } from "./score";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runQualification } from "./run";
import { RUNNER_FILES, runnerDigest } from "./fingerprint";
import { extractionV2SystemContent } from "../../packages/core/src/producer/prompt-v2";
import { RESPONSE_GAP_MS } from "./pacing";

const registry = candidateRegistry(WORLD_VOCABULARY_MODULES, ["concept", "situation"]);
type Rule = (typeof coreSemanticContract.cases)[number];
type ExtractRule = Extract<Rule, { expectation: "extract" }>;

function uniqueSpan(item: CoreSemanticCase, quote: string): TextAnchor {
  const index = item.records.findIndex(record => record.text.includes(quote)), record = item.records[index]!;
  const start = record.text.indexOf(quote);
  if (start < 0 || record.text.indexOf(quote, start + 1) >= 0) throw new Error("ambiguous test span");
  return { event_id: String(index + 1).padStart(26, "0"), start_utf16: start, end_utf16: start + quote.length };
}

function scripted(item: CoreSemanticCase): Observation {
  const input = coreSemanticCaseInput(item, registry), rule = coreSemanticContract.cases.find(row => row.case_id === item.id)!;
  if (rule.expectation === "abstain") return { case_id: item.id, input, status: "ok", response: { schema: "kizuki.producer-response/v2", mentions: [], claims: [] }, dropped: 0,
    usage: { calls: 1, input_tokens: 100, output_tokens: 10 } };
  const targetAnchor = uniqueSpan(item, rule.target.quote), target: DraftRef = { kind: "mention", id: "m-target" };
  const mentionSources = new Map<string, { ref: DraftRef; anchor: TextAnchor; attributionAnchor: TextAnchor; label: string }>();
  for (const contract of [rule.classification, ...rule.details]) if (contract.source !== undefined && typeof contract.source !== "string") {
    const key = canonicalJson(contract.source), anchor = uniqueSpan(item, contract.source.quote);
    if (!mentionSources.has(key)) mentionSources.set(key, { ref: { kind: "mention", id: `m-source-${mentionSources.size + 1}` }, anchor,
      attributionAnchor: uniqueSpan(item, contract.source.attribution_witness), label: contract.source.label });
  }
  const proposition = (id: string, predicate: string, object: RichClaimDraft["object"], contract: NonNullable<ExtractRule["label_alternatives"]>[number], body: string): RichClaimDraft => {
    const source = contract.source === undefined ? null : typeof contract.source === "string" ? ({ kind: "supplied", id: contract.source } as const) : mentionSources.get(canonicalJson(contract.source))!.ref;
    const perspective = contract.perspective === "direct"
      ? { holder: null, speaker: null, addressee: null, mode: "asserted" as const, interpretation: "explicit" as const, anchors: [] }
      : contract.perspective === "person_statement"
        ? { holder: null, speaker: source, addressee: null, mode: "reported" as const, interpretation: "explicit" as const, anchors: typeof contract.source === "string" ? input.supplied_refs.find(row => row.id === contract.source)!.anchors
          : [mentionSources.get(canonicalJson(contract.source!))!.anchor, mentionSources.get(canonicalJson(contract.source!))!.attributionAnchor] }
        : { holder: source, speaker: null, addressee: null, mode: "reported" as const, interpretation: "explicit" as const, anchors: typeof contract.source === "string" ? input.supplied_refs.find(row => row.id === contract.source)!.anchors
          : [mentionSources.get(canonicalJson(contract.source!))!.anchor, mentionSources.get(canonicalJson(contract.source!))!.attributionAnchor] };
    const time = contract.time === "unknown" ? { valid_from: null, valid_to: null, temporal_basis: "unknown" as const }
      : { valid_from: contract.time.valid_from, valid_to: contract.time.valid_to, temporal_basis: contract.time.temporal_basis };
    const witness = uniqueSpan(item, contract.witness), timeWitness = contract.time === "unknown" ? null : uniqueSpan(item, contract.time.witness);
    const roleWitness = contract.attribution_witness ?? (typeof contract.source === "object" ? contract.source.attribution_witness : undefined);
    const anchors = [targetAnchor, witness, ...(timeWitness === null ? [] : [timeWitness]), ...(roleWitness === undefined ? [] : [uniqueSpan(item, roleWitness)])];
    return { id, subject: target, predicate, object, perspective, context: [], polarity: "positive", body, ...time, confidence: 0.8, sensitivity: "personal",
      anchors: [...new Map(anchors.map(anchor => [canonicalJson(anchor), anchor])).values()] };
  };
  const claims: RichClaimDraft[] = [
    proposition("c1", "world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: rule.classification.kind } }, rule.classification, `${rule.classification.label} is classified as ${rule.classification.kind}.`),
    proposition("c2", `${item.kind}.label`, { kind: "literal", value: rule.classification.label }, rule.label_alternatives?.[0] ?? rule.classification, `The source names it ${rule.classification.label}.`),
    ...rule.details.map((detail, index) => { const literal = detail.required_atoms.join("; "); return proposition(`c${index + 3}`, detail.predicate, { kind: "literal", value: literal }, detail, literal); }),
  ];
  const mentions = [{ id: "m-target", label: rule.target.quote, anchor: targetAnchor, candidate_refs: [] },
    ...[...mentionSources.values()].map(source => ({ id: source.ref.id, label: source.label, anchor: source.anchor, candidate_refs: [] }))];
  return { case_id: item.id, input, status: "ok", response: { schema: "kizuki.producer-response/v2", mentions, claims } as ExtractResponseV2, dropped: 0,
    usage: { calls: 1, input_tokens: 100, output_tokens: 100 } };
}

const observations = () => coreSemanticCorpus.cases.map(scripted);
const mutate = (rows: Observation[], id: string, change: (response: ExtractResponseV2) => ExtractResponseV2) => rows.map(row => row.case_id === id ? { ...row, response: change(structuredClone(row.response!)) } : row);
const parsedObservation = (rows: Observation[], id: string) => {
  const row = rows.find(candidate => candidate.case_id === id)!;
  const { budget: _budget, ...input } = row.input;
  return parseExtractResponseV2(JSON.stringify(row.response), input);
};

describe("predeclared core semantic protocol", () => {
  test("the sealed split and scripted structural controls pass only to pending manual review", () => {
    validateCoreSemanticAssets();
    expect(coreSemanticCorpus.cases).toHaveLength(12);
    const rows = observations();
    for (const row of rows) { const { budget: _budget, ...input } = row.input, parsed = parseExtractResponseV2(JSON.stringify(row.response), input); if (!parsed.ok) throw new Error(`${row.case_id}: ${parsed.detail}`); }
    const result = scoreCoreSemanticRun(rows, registry);
    expect(result.cases.filter(row => !row.automated_passed).map(row => ({ id: row.case_id, gates: row.gates }))).toEqual([]);
    expect(result.automated_passed).toBe(true);
    expect(result.status).toBe("pending_manual_review");
    expect(result.cases.every(row => row.manual_review.status === "pending")).toBe(true);
    const report = "a".repeat(64), review = expectedCoreSemanticReview(report, result);
    expect(() => verifyCoreSemanticReview(report, result, review)).not.toThrow();
    expect(() => verifyCoreSemanticReview(report, result, { ...review, independent: false })).toThrow("review mismatch");
    expect(() => verifyCoreSemanticReview(report, result, { ...review, cases: review.cases.slice(1) })).toThrow("review mismatch");
  });

  test("negative claims, extra predicates, split targets and drops fail closed", () => {
    const negative = "core7-concept-negative-name", positive = "core7-concept-positive-shelf-current";
    const source = observations(), positiveClaim = source.find(row => row.case_id === positive)!.response!.claims[0]!;
    expect(scoreCoreSemanticRun(mutate(source, negative, response => ({ ...response, claims: [positiveClaim] })), registry).automated_passed).toBe(false);
    expect(scoreCoreSemanticRun(mutate(source, positive, response => ({ ...response, claims: [...response.claims, { ...response.claims[0]!, id: "extra" }] })), registry).automated_passed).toBe(false);
    const item = coreSemanticCorpus.cases.find(row => row.id === positive)!, secondAnchor = uniqueSpan(item, "ribbon of warmer water");
    const split = mutate(source, positive, response => ({ ...response,
      mentions: [...response.mentions, { id: "m-target-2", label: "ribbon of warmer water", anchor: secondAnchor, candidate_refs: [] }],
      claims: response.claims.map((claim, index) => index === 1 ? { ...claim, subject: { kind: "mention", id: "m-target-2" } } : claim) }));
    expect(parsedObservation(split, positive).ok).toBe(true);
    expect(scoreCoreSemanticRun(split, registry).automated_passed).toBe(false);
    expect(scoreCoreSemanticRun(source.map(row => row.case_id === positive ? { ...row, dropped: 1 } : row), registry).automated_passed).toBe(false);
  });

  test("unsupplied target nomination is exact and cannot be replaced, moved, split or omitted from the label evidence", () => {
    const id = "core7-concept-reported-prism-trace", direct = "core7-concept-positive-shelf-current", source = observations();
    const item = coreSemanticCorpus.cases.find(row => row.id === id)!, suppliedAnchor = uniqueSpan(item, "Liora said");
    const suppliedTarget = mutate(source, id, response => ({ ...response, claims: response.claims.map(claim => ({ ...claim,
      subject: { kind: "supplied", id: "source-core7-concept-reported" },
      anchors: [...new Map([...claim.anchors, suppliedAnchor].map(anchor => [canonicalJson(anchor), anchor])).values()] })) }));
    expect(parsedObservation(suppliedTarget, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(suppliedTarget, registry).automated_passed).toBe(false);

    const directItem = coreSemanticCorpus.cases.find(row => row.id === direct)!, wrongSpan = uniqueSpan(directItem, "ribbon of warmer water");
    const moved = mutate(source, direct, response => ({ ...response, mentions: response.mentions.map(mention => mention.id === "m-target" ? { ...mention, anchor: wrongSpan } : mention) }));
    expect(parsedObservation(moved, direct).ok).toBe(true);
    expect(scoreCoreSemanticRun(moved, registry).automated_passed).toBe(false);

    const outOfBounds = mutate(source, direct, response => ({ ...response, mentions: response.mentions.map(mention => mention.id === "m-target"
      ? { ...mention, anchor: { ...mention.anchor, end_utf16: directItem.records[0]!.text.length + 1 } } : mention) }));
    const outOfBoundsParsed = parsedObservation(outOfBounds, direct);
    expect(outOfBoundsParsed.ok && outOfBoundsParsed.dropped.length > 0).toBe(true);
    expect(scoreCoreSemanticRun(outOfBounds, registry).automated_passed).toBe(false);

    const wrongEvent = mutate(source, direct, response => ({ ...response, mentions: response.mentions.map(mention => mention.id === "m-target"
      ? { ...mention, anchor: { ...mention.anchor, event_id: "00000000000000000000000002" } } : mention) }));
    const wrongEventParsed = parsedObservation(wrongEvent, direct);
    expect(!wrongEventParsed.ok || wrongEventParsed.dropped.length > 0).toBe(true);
    expect(scoreCoreSemanticRun(wrongEvent, registry).automated_passed).toBe(false);

    const labelWithoutTarget = mutate(source, direct, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.label"
      ? { ...claim, anchors: claim.anchors.filter(anchor => canonicalJson(anchor) !== canonicalJson(response.mentions.find(mention => mention.id === "m-target")!.anchor)) } : claim) }));
    expect(parsedObservation(labelWithoutTarget, direct).ok).toBe(true);
    expect(scoreCoreSemanticRun(labelWithoutTarget, registry).automated_passed).toBe(false);
  });

  test("zero-ref reported Situation nominates a distinct exact speaker mention", () => {
    const id = "core7-situation-reported-east-duct", source = observations(), row = source.find(candidate => candidate.case_id === id)!;
    expect(row.input.supplied_refs).toEqual([]);
    expect(scoreCoreSemanticRun(source, registry).cases.find(candidate => candidate.case_id === id)!.automated_passed).toBe(true);
    const targetAnchor = row.response!.mentions.find(mention => mention.id === "m-target")!.anchor;
    const conflated = mutate(source, id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate.startsWith("situation.") && claim.predicate !== "situation.label"
      ? { ...claim, perspective: { ...claim.perspective, holder: null, speaker: { kind: "mention", id: "m-target" }, anchors: [targetAnchor] } } : claim) }));
    expect(parsedObservation(conflated, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(conflated, registry).automated_passed).toBe(false);

    const item = coreSemanticCorpus.cases.find(candidate => candidate.id === id)!, wrongSpan = uniqueSpan(item, "East duct review");
    const wrongSpeaker = mutate(source, id, response => ({ ...response,
      mentions: response.mentions.map(mention => mention.id === "m-source-1" ? { ...mention, anchor: wrongSpan } : mention),
      claims: response.claims.map(claim => claim.predicate.startsWith("situation.") && claim.predicate !== "situation.label"
        ? { ...claim, perspective: { ...claim.perspective, anchors: [wrongSpan] } } : claim) }));
    expect(parsedObservation(wrongSpeaker, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(wrongSpeaker, registry).automated_passed).toBe(false);
  });

  test("an authored equivalent person occurrence preserves attribution without asserting durable identity", () => {
    const id = "core7-concept-reported-prism-trace", source = observations();
    const item = coreSemanticCorpus.cases.find(row => row.id === id)!, name = uniqueSpan(item, "Liora"), role = uniqueSpan(item, "Liora said");
    const changed = mutate(source, id, response => ({ ...response,
      mentions: [...response.mentions, { id: "m-speaker", label: "Liora", anchor: name, candidate_refs: [] }],
      claims: response.claims.map(claim => claim.predicate === "concept.definition" ? { ...claim,
        perspective: { ...claim.perspective, speaker: { kind: "mention", id: "m-speaker" }, anchors: [name, role] } } : claim) }));
    expect(parsedObservation(changed, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(changed, registry).automated_passed).toBe(true);
    const wrong = mutate(changed, id, response => ({ ...response,
      mentions: response.mentions.map(mention => mention.id === "m-speaker" ? { ...mention, label: "Unrelated" } : mention) }));
    expect(scoreCoreSemanticRun(wrong, registry).automated_passed).toBe(false);
  });

  test("reported historical labels keep document roles and the exact interval", () => {
    const source = observations(), id = "core7-concept-historical-cobalt-pause";
    const changed = mutate(source, id, response => {
      const definition = response.claims.find(claim => claim.predicate === "concept.definition")!;
      return { ...response, claims: response.claims.map(claim => claim.predicate === "concept.label" ? { ...claim,
        perspective: definition.perspective, anchors: definition.anchors } : claim) };
    });
    expect(parsedObservation(changed, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(changed, registry).automated_passed).toBe(true);
    const speaker = mutate(changed, id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.label"
      ? { ...claim, perspective: { ...claim.perspective, speaker: claim.perspective.holder, holder: null } } : claim) }));
    expect(scoreCoreSemanticRun(speaker, registry).automated_passed).toBe(false);
    const flattened = mutate(changed, id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.label"
      ? { ...claim, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] } } : claim) }));
    expect(parsedObservation(flattened, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(flattened, registry).automated_passed).toBe(false);
  });

  test("one attributed detail cannot borrow another claim's reporting evidence", () => {
    const source = observations(), id = "core7-situation-reported-east-duct", item = coreSemanticCorpus.cases.find(row => row.id === id)!;
    const name = uniqueSpan(item, "Soren"), target = uniqueSpan(item, "East duct review"), fact = uniqueSpan(item, "the calibrated thermal probe is still with the service centre");
    const changed = mutate(source, id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "situation.blocker"
      ? { ...claim, anchors: [target, fact], perspective: { ...claim.perspective, anchors: [name] } } : claim) }));
    expect(parsedObservation(changed, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(changed, registry).automated_passed).toBe(false);
  });

  test("grounded legacy extras remain pending per-claim review while forbidden and typed extras fail", () => {
    const lamp = "core7-situation-positive-gate-survey", west = "core7-situation-reported-east-duct", source = observations();
    const lampRow = source.find(row => row.case_id === lamp)!, lampItem = coreSemanticCorpus.cases.find(row => row.id === lamp)!;
    const target = lampRow.response!.mentions.find(mention => mention.id === "m-target")!, active = uniqueSpan(lampItem, "active situation");
    const status: RichClaimDraft = { id: "legacy-status", subject: { kind: "mention", id: target.id }, predicate: "project.status",
      object: { kind: "literal", value: "active" }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
      context: [], polarity: "positive", body: "Gate survey is active.", valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.8,
      sensitivity: "personal", anchors: [target.anchor, active] };
    const withStatus = mutate(source, lamp, response => ({ ...response, claims: [...response.claims, status] }));
    expect(parsedObservation(withStatus, lamp).ok).toBe(true);
    const statusResult = scoreCoreSemanticRun(withStatus, registry), statusCase = statusResult.cases.find(row => row.case_id === lamp)!;
    expect(statusResult.automated_passed).toBe(true);
    expect(statusCase.manual_review.legacy_extras).toEqual([{ claim_id: status.id, predicate: status.predicate, claim_sha256: sha256(canonicalJson(status)) }]);
    const statusReview = expectedCoreSemanticReview("d".repeat(64), statusResult), reviewed = statusReview.cases.find(row => row.case_id === lamp)!;
    expect("legacy_extras" in reviewed && reviewed.legacy_extras[0]).toMatchObject({ claim_id: status.id, source_entailment: "passed", references_grounded: "passed" });

    const westRow = source.find(row => row.case_id === west)!, speaker = westRow.response!.mentions.find(mention => mention.id === "m-source-1")!;
    const displayName: RichClaimDraft = { ...status, id: "legacy-speaker-name", subject: { kind: "mention", id: speaker.id }, predicate: "identity.display_name",
      object: { kind: "literal", value: "Soren" }, body: "The grounded speaker is named Soren.", anchors: [speaker.anchor] };
    const withDisplayName = mutate(source, west, response => ({ ...response, claims: [...response.claims, displayName] }));
    expect(parsedObservation(withDisplayName, west).ok).toBe(true);
    expect(scoreCoreSemanticRun(withDisplayName, registry).automated_passed).toBe(true);

    for (const predicate of ["identity.same_as", "project.owns", "situation.change"]) {
      const changed = mutate(source, lamp, response => ({ ...response, claims: [...response.claims, { ...status, predicate }] }));
      expect(parsedObservation(changed, lamp).ok).toBe(true);
      expect(scoreCoreSemanticRun(changed, registry).automated_passed).toBe(false);
    }
    const changedStatus = scoreCoreSemanticRun(mutate(withStatus, lamp, response => ({ ...response, claims: response.claims.map(claim => claim.id === status.id ? { ...claim, body: `${claim.body} Unsupported.` } : claim) })), registry);
    expect(changedStatus.automated_passed).toBe(true);
    expect(() => verifyCoreSemanticReview("d".repeat(64), changedStatus, statusReview)).toThrow("review mismatch");
  });

  test("classification, witness, attribution, time and usage mutations are rejected", () => {
    const direct = "core7-concept-positive-shelf-current", person = "core7-concept-reported-prism-trace", document = "core7-concept-historical-cobalt-pause";
    const source = observations();
    const changed = [
      mutate(source, direct, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "world.kind" ? { ...claim, perspective: { ...claim.perspective, mode: "reported" } } : claim) })),
      mutate(source, person, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.definition" ? { ...claim, perspective: { ...claim.perspective, speaker: null, anchors: [] } } : claim) })),
      mutate(source, document, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.definition" ? { ...claim, perspective: { ...claim.perspective, speaker: claim.perspective.holder } } : claim) })),
      mutate(source, document, response => ({ ...response, claims: response.claims.map(claim => ({ ...claim, valid_to: "2015-06-02T00:00:00Z" })) })),
      source.map(row => row.case_id === direct ? { ...row, usage: { ...row.usage, output_tokens: null } } : row),
    ];
    for (const observations of changed) expect(scoreCoreSemanticRun(observations, registry).automated_passed).toBe(false);
  });

  test("a changed exact response cannot reuse an independent review", () => {
    const report = "b".repeat(64), first = scoreCoreSemanticRun(observations(), registry), review = expectedCoreSemanticReview(report, first);
    const changed = scoreCoreSemanticRun(mutate(observations(), "core7-concept-positive-shelf-current", response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.definition" && claim.object.kind === "literal" ? { ...claim, object: { ...claim.object, value: `${claim.object.value}.` } } : claim) })), registry);
    expect(changed.automated_passed).toBe(true);
    expect(() => verifyCoreSemanticReview(report, changed, review)).toThrow("review mismatch");
  });

  test("parser-valid adjacent anchors remain eligible for independent semantic review", () => {
    const id = "core7-concept-positive-shelf-current", source = observations(), item = coreSemanticCorpus.cases.find(row => row.id === id)!, rule = coreSemanticContract.cases.find(row => row.case_id === id)!;
    if (rule.expectation !== "extract") throw new Error("invalid test rule");
    const witness = uniqueSpan(item, rule.details[0]!.witness), midpoint = witness.start_utf16 + Math.floor((witness.end_utf16 - witness.start_utf16) / 2);
    const changed = mutate(source, id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === rule.details[0]!.predicate
      ? { ...claim, anchors: [claim.anchors[0]!, { ...witness, end_utf16: midpoint }, { ...witness, start_utf16: midpoint }] } : claim) }));
    expect(scoreCoreSemanticRun(changed, registry).automated_passed).toBe(true);
  });

  test("a semantically insufficient but parser-valid anchor change requires a new independent review", () => {
    const id = "core7-concept-positive-shelf-current", report = "c".repeat(64), source = observations(), first = scoreCoreSemanticRun(source, registry), review = expectedCoreSemanticReview(report, first);
    const changed = scoreCoreSemanticRun(mutate(source, id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.definition" ? { ...claim, anchors: claim.anchors.slice(0, 1) } : claim) })), registry);
    expect(changed.automated_passed).toBe(true);
    expect(() => verifyCoreSemanticReview(report, changed, review)).toThrow("review mismatch");
  });

  test("runner mode fixes the full split and emits only a pending core result without a model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "core-semantic-runner-"));
    try {
      await expect(runQualification({ protocol: "unknown" as never, kinds: ["concept", "situation"] })).rejects.toThrow("unknown qualification protocol");
      await expect(runQualification({ protocol: "core-semantic-v1", kinds: ["concept", "situation"], case_ids: [coreSemanticCorpus.cases[0]!.id] })).rejects.toThrow("fixed core split");
      const output = join(directory, "pending.json"), result = await runQualification({ protocol: "core-semantic-v1", kinds: ["concept", "situation"], output });
      expect(result.core_semantic.status).toBe("pending_manual_review");
      expect(result.core_semantic.automated_passed).toBe(false);
      expect(result.traces).toEqual([]);
      expect(result.missing).toContain("model_unconfigured");
      const stored = JSON.parse(readFileSync(output, "utf8"));
      expect(stored.protocol).toBe("core-semantic-v1");
      expect(Object.hasOwn(stored, "score")).toBe(false);
      expect(Object.hasOwn(stored, "supplemental")).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("registry acceptance requires the exact report and separate hash-bound independent review", () => {
    const directory = mkdtempSync(join(tmpdir(), "core-semantic-review-"));
    try {
      for (const path of RUNNER_FILES) { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), readFileSync(join(import.meta.dir, "../..", path))); }
      const rows = observations(), result = scoreCoreSemanticRun(rows, registry), started = Date.UTC(2026, 9, 22);
      const traces = rows.map((row, index) => ({ case_id: row.case_id, prompt_sha256: sha256(extractionV2SystemContent(row.input)), transport: "ok" as const,
        request_sha256: "a".repeat(64), response_sha256: "b".repeat(64), origin: "observed_v2" as const, http_status: 200,
        started_at: new Date(started + index * (RESPONSE_GAP_MS + 1_000)).toISOString(), completed_at: new Date(started + index * (RESPONSE_GAP_MS + 1_000) + 1_000).toISOString() }));
      const report = { schema: "kizuki.world-qualification-run/v2" as const, protocol: "core-semantic-v1" as const, evidence: "runner_observed_transport" as const,
        synthetic: true, source_clean: true, source_commit: "a".repeat(40), runner_sha256: runnerDigest(directory), registry_sha256: registryDigest(registry),
        model: "synthetic-verifier-control", endpoint_host: "127.0.0.1:1", selected_kinds: ["concept", "situation"], selected_extensions: [],
        corpus: coreSemanticCorpus, observations: rows, traces, missing: [], selected_cases: rows.map(row => row.case_id), resumed_from: null, halt_reason: null,
        response_gap_ms: RESPONSE_GAP_MS, attempts: rows.length, case_states: rows.map(row => ({ case_id: row.case_id, status: "observed" as const })),
        prompt_sha256: traces[0]!.prompt_sha256, prompt_sha256_by_case: Object.fromEntries(traces.map(trace => [trace.case_id, trace.prompt_sha256])),
        limitations: ["synthetic verifier control"], core_semantic: result };
      const bytes = JSON.stringify(report), reportSha256 = sha256(bytes), review = JSON.stringify(expectedCoreSemanticReview(reportSha256, result));
      const fixture = join(directory, "scripts/fixtures/world-qualification/core-semantic-review.json");
      mkdirSync(dirname(fixture), { recursive: true }); writeFileSync(fixture, review);
      const approval = { file: "core-semantic-control.json", sha256: reportSha256, endpoint_evidence: "c".repeat(64),
        body_review: { file: "core-semantic-review.json", sha256: sha256(review) } };
      expect(() => verifyQualificationReceipt(bytes, { file: approval.file, sha256: approval.sha256, endpoint_evidence: approval.endpoint_evidence }, registry, directory)).toThrow("independent review missing");
      const checked = verifyQualificationReceipt(bytes, approval, registry, directory);
      expect(() => checkOfferedQualification(registry, [checked])).not.toThrow();
      const changedReview = JSON.stringify({ ...JSON.parse(review), independent: false }); writeFileSync(fixture, changedReview);
      expect(() => verifyQualificationReceipt(bytes, { ...approval, body_review: { ...approval.body_review, sha256: sha256(changedReview) } }, registry, directory)).toThrow("review mismatch");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
