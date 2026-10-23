import { expect, test } from "bun:test";
import fixture from "../fixtures/producer-raw-attribution.json";
import { activeWorldRegistry } from "../../src/contracts/world-vocabulary";
import { parseExtractResponseV2 } from "../../src/contracts/producer-v2";
import { resolveModelExtractionWire } from "../../src/producer/model-v2-wire";
import { extractionV2SystemContent } from "../../src/producer/prompt-v2";
import { coreSemanticAssets, coreSemanticCaseInput, prepareCoreSemanticObservation, scoreCoreSemanticRepresentations } from "../../../../scripts/world-qualification/core-semantic";
import { UNION_INPUT_POLICY } from "../../../../scripts/world-qualification/union-assets";
import type { Observation } from "../../../../scripts/world-qualification/score";

const registry = activeWorldRegistry(), assets = coreSemanticAssets("union22");
const item = assets.corpus.cases.find(row => row.id === fixture.case_id)!;
const rule = assets.contract.cases.find(row => row.case_id === fixture.case_id)!;
const input = coreSemanticCaseInput(item, registry, UNION_INPUT_POLICY);
const { budget: _budget, ...parseInput } = input;
const raw = JSON.parse(fixture.raw_text);
const attributed = (wire: typeof raw) => wire.claims.filter((claim: any) => claim.perspective.speaker !== null);
const branch = "branches" in rule ? rule.branches[0]! : rule;
if (!("details" in branch)) throw Error("fixture requires typed detail rules");
const witness = branch.details[0]!.attribution_witness!;
const roleAnchor = raw.mentions.find((mention: any) => mention.id === attributed(raw)[0].perspective.speaker.id).anchor;

function observation(wire = raw): Observation {
  const resolved = resolveModelExtractionWire(JSON.stringify(wire), parseInput);
  if (!resolved.ok) throw Error("wire rejected");
  const parsed = parseExtractResponseV2(resolved.text, parseInput);
  if (!parsed.ok || parsed.dropped.length) throw Error("draft rejected");
  return { case_id: item.id, input, status: "ok", response: parsed.response, dropped: 0,
    usage: { calls: 1, input_tokens: 7_000, output_tokens: 2_000 } };
}
const score = (observed: Observation) => scoreCoreSemanticRepresentations(item, rule, observed, registry, UNION_INPUT_POLICY);

test("trusted prompt requires complete raw attribution evidence in addition to exact role anchors", () => {
  const system = extractionV2SystemContent(input);
  expect(system.includes("complete actual source phrase linking each holder, speaker or addressee to that proposition")).toBe(true);
  expect(system.includes("Preserve every required exact role-ref anchor as well")).toBe(true);
  expect(system.includes("A name, perspective mode, body text or host-added window alone is insufficient")).toBe(true);
  expect(system.includes("quote/select spans")).toBe(true);
  expect(system).not.toContain(witness);
});

test("name-only model citations fail the unchanged raw gate even when real preparation adds sent context", () => {
  const observed = observation(), before = JSON.stringify(observed.response), checked = score(observed);
  expect(checked.automated_passed).toBe(false);
  expect(checked.gates.attribution).toEqual(["situation.objective:perspective", "situation.blocker:perspective"]);
  const prepared = prepareCoreSemanticObservation(observed, registry, item);
  expect(prepared.errors).toEqual([]);
  expect(prepared.drafts).toHaveLength(4);
  const anchors = new Map(prepared.drafts.map((draft, index) => [observed.response!.claims[index]!.id, draft.semantic.perspective.anchors]));
  expect(scoreCoreSemanticRepresentations(item, rule, observed, registry, UNION_INPUT_POLICY, anchors).automated_passed).toBe(true);
  expect(JSON.stringify(observed.response)).toBe(before);
});

test.each([
  ["complete reporting phrase", true],
  ["larger quote selecting only the name", false],
  ["unrelated source phrase", false],
  ["wrong speaker despite correct reporting phrase", false],
] as const)("raw attribution boundary: %s", (variant, accepted) => {
  const wire = structuredClone(raw);
  for (const claim of attributed(wire)) {
    if (variant === "larger quote selecting only the name") {
      claim.perspective.anchors = [{ event_id: roleAnchor.event_id, quote: witness, select: raw.mentions[1].label }];
      continue;
    }
    claim.perspective.anchors.push({ event_id: roleAnchor.event_id,
      quote: variant === "unrelated source phrase" ? raw.mentions[0].label : witness });
    if (variant === "wrong speaker despite correct reporting phrase") {
      claim.perspective.speaker = { kind: "mention", id: raw.mentions[0].id };
      claim.perspective.anchors.push(raw.mentions[0].anchor);
    }
  }
  const checked = score(observation(wire));
  expect(checked.automated_passed).toBe(accepted);
  expect(checked.gates.attribution.length === 0).toBe(accepted);
});

test("a complete reporting phrase does not replace the exact required role-ref anchor", () => {
  const wire = structuredClone(raw);
  for (const claim of attributed(wire)) claim.perspective.anchors = [{ event_id: roleAnchor.event_id, quote: witness }];
  const resolved = resolveModelExtractionWire(JSON.stringify(wire), parseInput);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw Error("wire rejected");
  const parsed = parseExtractResponseV2(resolved.text, parseInput);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw Error(parsed.detail);
  expect(parsed.dropped).toHaveLength(2);
});
