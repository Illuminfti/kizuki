import { describe, expect, test } from "bun:test";
import { semanticKey, supportKey } from "../../src/claims/claim-v2-keys";
import type { OccurrenceEventIdentity } from "../../src/claims/occurrences";
import type { ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { EXTRACT_RESPONSE_V2_SCHEMA, parseExtractResponseV2, type ExtractResponseV2, type ProduceInputV2, type RichClaimDraft, type TextAnchor } from "../../src/contracts/producer-v2";
import { prepareWorldDrafts, type SentEvidenceWindow, type WorldDraftContext } from "../../src/producer/world-drafts";

const eventId = "00000000000000000000000001";
const otherId = "00000000000000000000000003";
const sourceKey = "00000000000000000000000002";
const otherSourceKey = "00000000000000000000000004";
const identity: OccurrenceEventIdentity = {
  connector_id: "fixture", source_record_id: "record-1", event_id: eventId,
  content_hash_version: 1, content_hash: "a".repeat(64), text_hash: "b".repeat(64),
  origin_binding: "origin", accepted_at: "2026-01-01T00:00:00.000Z",
};

function span(text: string, phrase: string, id = eventId): TextAnchor {
  const start = text.indexOf(phrase);
  if (start < 0) throw new Error(`missing fixture phrase: ${phrase}`);
  return { event_id: id, start_utf16: start, end_utf16: start + phrase.length };
}

function fixture(text = "Priya said Cobalt pause is the adopted name.") {
  const name = span(text, "Priya"), role = span(text, "Priya said"), fact = span(text, "Cobalt pause");
  const window: SentEvidenceWindow = { event_id: eventId, start_utf16: 0, end_utf16: text.length, text };
  const input: ProduceInputV2 = {
    events: [{ event_id: eventId, text }], supplied_refs: [], vocabulary_refs: [], predicates: [],
    budget: { max_calls: 1, max_input_tokens: 1000, max_output_tokens: 1000 },
  };
  const context: WorldDraftContext = {
    events: [{ ...identity, source_key: sourceKey, text, subjects: [] }], supplied_refs: new Map(),
    sent_evidence_windows: [window], model_ref: "fixture-model",
  };
  const claim = (over: Partial<RichClaimDraft> = {}): RichClaimDraft => ({
    id: "c0", subject: { kind: "mention", id: "m0" }, predicate: "concept.definition",
    object: { kind: "literal", value: "Cobalt pause" },
    perspective: { holder: null, speaker: { kind: "mention", id: "m0" }, addressee: null,
      mode: "reported", interpretation: "explicit", anchors: [name, role] },
    context: [], polarity: "positive", body: "Cobalt pause", valid_from: null, valid_to: null,
    temporal_basis: "unknown", confidence: 0.8, sensitivity: "public", anchors: [name, fact], ...over,
  });
  const response = (value = claim()): ExtractResponseV2 => ({
    schema: EXTRACT_RESPONSE_V2_SCHEMA,
    mentions: [{ id: "m0", label: "Priya", anchor: name, candidate_refs: [] }], claims: [value],
  });
  return { text, name, role, fact, window, input, context, claim, response };
}

function semantic(f: ReturnType<typeof fixture>, claim = f.claim(), context = f.context): ClaimV2Assertion {
  const prepared = prepareWorldDrafts(f.response(claim), f.input, context);
  expect(prepared.dropped).toEqual([]);
  expect(prepared.drafts).toHaveLength(1);
  return prepared.drafts[0]!.semantic;
}

// Public synthetic report: the issue date is metadata, not an action-validity interval.
function maintenanceOutline() {
  const holder = "Maintenance circular MC-87", situation = "Cedar Basin Hold";
  const heading = "Reconcile sensor tags";
  const action = "Reconcile all 26 unlinked sensor tags with their intake rows so the missing calibration checks can proceed.";
  const role = "MC-87 suggests this action:";
  const sent = `${holder}\nIssued: 2033-04-18 (publication date only).\n${situation} — Situation\nTask outline: ${heading}.\n${role} ${action}`;
  const text = `${sent}\nUnsent later note: The action was cancelled on 2034-07-09.`;
  const holderAnchor = span(text, holder), situationAnchor = span(text, situation);
  const roleAnchor = span(text, role), fact = span(text, action);
  const window: SentEvidenceWindow = { event_id: eventId, start_utf16: 0, end_utf16: sent.length, text: sent };
  const input: ProduceInputV2 = { events: [{ event_id: eventId, text }], supplied_refs: [], vocabulary_refs: [],
    predicates: [{ id: "situation.objective", object_kinds: ["literal"] }],
    budget: { max_calls: 1, max_input_tokens: 1000, max_output_tokens: 1000 } };
  const context: WorldDraftContext = { events: [{ ...identity, source_key: sourceKey, text, subjects: [] }],
    supplied_refs: new Map(), sent_evidence_windows: [window], model_ref: "fixture-model" };
  const claim: RichClaimDraft = { id: "maintenance-action", subject: { kind: "mention", id: "situation" },
    predicate: "situation.objective", object: { kind: "literal", value: action },
    perspective: { holder: { kind: "mention", id: "document" }, speaker: null, addressee: null,
      mode: "suggested", interpretation: "explicit", anchors: [holderAnchor, roleAnchor] },
    context: [], polarity: "positive", body: `MC-87 suggests: ${action}`, valid_from: null, valid_to: null,
    temporal_basis: "unknown", confidence: 0.8, sensitivity: "public", anchors: [situationAnchor, fact] };
  const response = (value = claim): ExtractResponseV2 => ({ schema: EXTRACT_RESPONSE_V2_SCHEMA,
    mentions: [{ id: "document", label: holder, anchor: holderAnchor, candidate_refs: [] },
      { id: "situation", label: situation, anchor: situationAnchor, candidate_refs: [] }], claims: [value] });
  const prepare = (value = claim, ctx = context) => prepareWorldDrafts(response(value), input, ctx);
  return { action, heading, text, sent, fact, window, input, context, claim, response, prepare };
}

describe("suggested maintenance outline evidence", () => {
  test("the complete count and purpose remain in the literal while exact sent context exposes only the publication date", () => {
    const f = maintenanceOutline(), { budget: _budget, ...parseInput } = f.input;
    const parsed = parseExtractResponseV2(JSON.stringify(f.response()), { ...parseInput, events: [{ event_id: eventId, text: f.sent }] });
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(parsed.dropped).toEqual([]);
    const prepared = prepareWorldDrafts(parsed.response, f.input, f.context);
    expect(prepared.dropped).toEqual([]);
    const draft = prepared.drafts[0]!;
    expect(draft.semantic).toMatchObject({ object: { kind: "literal", value: f.action },
      perspective: { mode: "suggested", interpretation: "explicit", speaker: null, addressee: null },
      valid_from: null, valid_to: null, temporal_basis: "unknown" });
    expect(draft.semantic.perspective.holder).not.toBeNull();
    expect(draft.semantic.perspective.anchors).toEqual([...f.claim.perspective.anchors,
      { event_id: eventId, start_utf16: 0, end_utf16: f.sent.length }]);
    expect(draft.semantic.anchors).toEqual(f.claim.anchors);
    expect(draft.body).toBe(f.claim.body);
    const withoutContext = f.prepare(f.claim, { ...f.context, sent_evidence_windows: [] }).drafts[0]!.semantic;
    expect(semanticKey(draft.semantic)).toBe(semanticKey(withoutContext));
    const retained = draft.semantic.perspective.anchors.map(a => f.text.slice(a.start_utf16, a.end_utf16)).join("\n");
    expect(retained).toContain("Issued: 2033-04-18");
    expect(retained).not.toContain("2034-07-09");
  });

  test("context does not complete a heading-only object or rescue a non-grounded detail", () => {
    const f = maintenanceOutline();
    // Heading-only can satisfy literal grounding; this is a limitation, not a semantic pass.
    const heading = { ...f.claim, object: { kind: "literal" as const, value: f.heading },
      anchors: [f.claim.anchors[0]!, span(f.text, f.heading)], body: f.heading };
    const prepared = f.prepare(heading).drafts[0]!;
    expect(prepared.semantic.object).toEqual(heading.object);
    expect(prepared.semantic.perspective.anchors).toContainEqual({ event_id: eventId, start_utf16: 0, end_utf16: f.sent.length });
    const invented = { ...f.claim, object: { kind: "literal" as const, value: "Reconcile all 99 sensor tags" } };
    const downgraded = f.prepare(invented).drafts[0]!.semantic;
    expect(downgraded.object).toEqual(invented.object);
    expect(downgraded.perspective).toMatchObject({ mode: "uncertain", interpretation: "inferred" });
    expect(downgraded.perspective.anchors).toEqual(f.claim.perspective.anchors);
  });

  test("forged, duplicate, out-of-bounds and role-excluding windows cannot enlarge suggested evidence", () => {
    const f = maintenanceOutline();
    for (const windows of [
      [{ ...f.window, text: f.sent + " forged date" }], [f.window, f.window],
      [{ ...f.window, end_utf16: f.text.length + 1 }],
      [{ event_id: eventId, start_utf16: f.fact.start_utf16, end_utf16: f.fact.end_utf16, text: f.action }],
    ]) {
      const prepared = f.prepare(f.claim, { ...f.context, sent_evidence_windows: windows });
      expect(prepared.dropped).toEqual([]);
      expect(prepared.drafts[0]!.semantic.perspective.anchors).toEqual(f.claim.perspective.anchors);
    }
  });

  test("suggested speaker-only, unattributed and role-anchor-free claims do not gain context", () => {
    const f = maintenanceOutline();
    for (const perspective of [
      { ...f.claim.perspective, holder: null, speaker: f.claim.perspective.holder },
      { ...f.claim.perspective, holder: null, anchors: [] },
    ]) {
      expect(f.prepare({ ...f.claim, perspective }).drafts[0]!.semantic.perspective.anchors).toEqual(perspective.anchors);
    }
    expect(() => f.prepare({ ...f.claim, perspective: { ...f.claim.perspective, anchors: [] } }))
      .toThrow("mention is unsupported by claim evidence");
  });

  test("suggested context exceeding the existing per-item anchor cap drops the claim", () => {
    const f = maintenanceOutline();
    const anchors = [...f.claim.perspective.anchors, ...Array.from({ length: 6 }, (_, i): TextAnchor =>
      ({ event_id: eventId, start_utf16: 1 + i, end_utf16: 2 + i }))];
    expect(f.prepare({ ...f.claim, perspective: { ...f.claim.perspective, anchors } })).toEqual({
      drafts: [], dropped: [{ reason: "invalid_claim", id: f.claim.id }],
    });
  });
});

describe("host sent evidence context", () => {
  test("reported and quoted literals retain exact role evidence and gain only their actual sent window", () => {
    for (const mode of ["reported", "quoted"] as const) {
      const f = fixture();
      const otherText = "Unrelated source text.";
      const context: WorldDraftContext = { ...f.context,
        events: [...f.context.events, { ...identity, event_id: otherId, source_record_id: "record-2",
          source_key: otherSourceKey, text: otherText, subjects: [] }],
        sent_evidence_windows: [f.window, { event_id: otherId, start_utf16: 0, end_utf16: otherText.length, text: otherText }],
      };
      const input = { ...f.input, events: [...f.input.events, { event_id: otherId, text: otherText }] };
      const claim = f.claim({ perspective: { ...f.claim().perspective, mode } });
      const prepared = prepareWorldDrafts(f.response(claim), input, context);
      expect(prepared.dropped).toEqual([]);
      expect(prepared.drafts[0]!.semantic.anchors).toEqual([f.name, f.fact]);
      expect(prepared.drafts[0]!.semantic.perspective.anchors).toEqual([
        f.name, f.role, { event_id: eventId, start_utf16: 0, end_utf16: f.text.length },
      ]);
      expect(prepared.drafts[0]!.semantic.perspective.anchors.some(anchor => anchor.event_id === otherId)).toBe(false);
    }
  });

  test("the original guard runs first, so context cannot rescue a bad fact", () => {
    const f = fixture("Priya said Cobalt pause. Invented label appears later.");
    const claim = f.claim({ object: { kind: "literal", value: "Invented label" }, body: "Invented label" });
    const result = semantic(f, claim);
    expect(result.perspective).toMatchObject({ mode: "uncertain", interpretation: "inferred" });
    expect(result.perspective.anchors).toEqual([f.name, f.role]);
  });

  test("an exact reported literal stays explicit while a determiner paraphrase is downgraded before sent context", () => {
    const f = fixture("Priya said Cobalt pause is the paced recall practice.");
    const exact = "the paced recall practice", fact = span(f.text, exact);
    const body = "Priya describes Cobalt pause as a paced recall practice.";
    const input: ProduceInputV2 = { ...f.input, predicates: [{ id: "concept.definition", object_kinds: ["literal"] }] };
    const { budget: _budget, ...parseInput } = input;
    for (const value of [exact, "a paced recall practice"]) {
      const claim = f.claim({ subject: { kind: "mention", id: "m1" }, object: { kind: "literal", value }, body,
        anchors: [f.fact, fact] });
      const wire: ExtractResponseV2 = { ...f.response(claim), mentions: [...f.response().mentions,
        { id: "m1", label: "Cobalt pause", anchor: f.fact, candidate_refs: [] }] };
      const parsed = parseExtractResponseV2(JSON.stringify(wire), parseInput);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("scripted literal control must parse");
      expect(parsed.dropped).toEqual([]);
      const prepared = prepareWorldDrafts(parsed.response, input, f.context);
      expect(prepared.dropped).toEqual([]);
      expect(prepared.drafts).toHaveLength(1);
      const draft = prepared.drafts[0]!;
      expect(draft.semantic.object).toEqual({ kind: "literal", value });
      expect(draft.semantic.perspective.speaker).not.toEqual(draft.semantic.subject);
      expect(draft.semantic.perspective).toMatchObject(value === exact
        ? { mode: "reported", interpretation: "explicit" } : { mode: "uncertain", interpretation: "inferred" });
      expect(draft.semantic.perspective.anchors).toEqual(value === exact
        ? [f.name, f.role, { event_id: eventId, start_utf16: 0, end_utf16: f.text.length }] : [f.name, f.role]);
      expect(draft.world_admission.rendering.body).toBe(body);
    }
  });

  test("a segment adds its sent prefix and never the unseen suffix", () => {
    const prefix = "Priya said Cobalt pause.";
    const f = fixture(`${prefix} The unseen suffix records a different statement.`);
    const context = { ...f.context, sent_evidence_windows: [{ event_id: eventId, start_utf16: 0,
      end_utf16: prefix.length, text: prefix }] };
    const result = semantic(f, f.claim(), context);
    expect(result.perspective.anchors).toEqual([
      f.name, f.role, { event_id: eventId, start_utf16: 0, end_utf16: prefix.length },
    ]);
    expect(result.perspective.anchors[2]!.end_utf16).toBeLessThan(f.text.length);
  });

  test("redacted, malformed, ambiguous, and cross-event windows leave prior guard output unchanged", () => {
    const secret = fixture("Priya said Cobalt pause. API_KEY=abcdefghijk");
    const otherText = "Priya said Cobalt pause.";
    const otherEvent = { ...identity, event_id: otherId, source_record_id: "record-2", source_key: sourceKey,
      text: otherText, subjects: [] };
    const cases: WorldDraftContext[] = [
      secret.context,
      { ...secret.context, sent_evidence_windows: [{ ...secret.window, text: "wrong" }] },
      { ...secret.context, sent_evidence_windows: [secret.window, secret.window] },
      { ...secret.context, events: [...secret.context.events, otherEvent],
        sent_evidence_windows: [{ event_id: otherId, start_utf16: 0, end_utf16: otherText.length, text: otherText }] },
    ];
    for (const context of cases) {
      const input = context.events.length === 1 ? secret.input
        : { ...secret.input, events: [...secret.input.events, { event_id: otherId, text: otherText }] };
      const prepared = prepareWorldDrafts(secret.response(), input, context);
      expect(prepared.drafts[0]!.semantic.perspective.anchors).toEqual([secret.name, secret.role]);
    }
  });

  test("claims without an attributed role are unchanged", () => {
    const f = fixture();
    const claim = f.claim({ perspective: { holder: null, speaker: null, addressee: null,
      mode: "reported", interpretation: "explicit", anchors: [] } });
    expect(semantic(f, claim).perspective.anchors).toEqual([]);
  });

  test("context never guesses or corrects a crossed attribution role", () => {
    const f = fixture("Priya said Cobalt pause. Dalen said River hold.");
    const dalen = span(f.text, "Dalen"), wrongRole = span(f.text, "Dalen said");
    const claim = f.claim({ perspective: { ...f.claim().perspective,
      speaker: { kind: "mention", id: "m1" }, anchors: [dalen, wrongRole] } });
    const wire = f.response(claim);
    const prepared = prepareWorldDrafts({ ...wire, mentions: [...wire.mentions,
      { id: "m1", label: "Dalen", anchor: dalen, candidate_refs: [] }] }, f.input, f.context);
    const result = prepared.drafts[0]!.semantic;
    expect(result.perspective.speaker).not.toEqual(result.subject);
    expect(result.perspective.anchors).toEqual([
      dalen, wrongRole, { event_id: eventId, start_utf16: 0, end_utf16: f.text.length },
    ]);
  });

  test("a role grounded in another same-source event cannot borrow the fact window", () => {
    const f = fixture();
    const otherText = "Dalen said River hold.";
    const dalen = span(otherText, "Dalen", otherId), dalenRole = span(otherText, "Dalen said", otherId);
    const context: WorldDraftContext = { ...f.context,
      events: [...f.context.events, { ...identity, event_id: otherId, source_record_id: "record-2",
        source_key: sourceKey, text: otherText, subjects: [] }],
      sent_evidence_windows: [f.window, { event_id: otherId, start_utf16: 0, end_utf16: otherText.length, text: otherText }],
    };
    const input = { ...f.input, events: [...f.input.events, { event_id: otherId, text: otherText }] };
    const claim = f.claim({ perspective: { ...f.claim().perspective,
      speaker: { kind: "mention", id: "m1" }, anchors: [f.role, dalen] } });
    const wire = f.response(claim);
    const prepared = prepareWorldDrafts({ ...wire, mentions: [...wire.mentions,
      { id: "m1", label: "Dalen", anchor: dalen, candidate_refs: [] }] }, input, context);
    expect(prepared.dropped).toEqual([]);
    expect(prepared.drafts[0]!.semantic.perspective.anchors).toEqual([f.role, dalen]);
    expect(prepared.drafts[0]!.semantic.perspective.anchors).not.toContainEqual(dalenRole);
  });

  test("adding a sent window beyond the eight-anchor cap drops the whole claim", () => {
    const f = fixture();
    const anchors: TextAnchor[] = [f.name, ...Array.from({ length: 7 }, (_, index): TextAnchor => ({
      event_id: eventId, start_utf16: index + 5, end_utf16: index + 6,
    }))];
    const claim = f.claim({ perspective: { ...f.claim().perspective, anchors } });
    expect(prepareWorldDrafts(f.response(claim), f.input, f.context)).toEqual({
      drafts: [], dropped: [{ reason: "invalid_claim", id: "c0" }],
    });
  });

  test("added windows cannot exceed the aggregate anchor cap", () => {
    const f = fixture();
    const roleAnchors: TextAnchor[] = [f.name, ...Array.from({ length: 6 }, (_, index): TextAnchor => ({
      event_id: eventId, start_utf16: index + 5, end_utf16: index + 6,
    }))];
    const claims = Array.from({ length: 28 }, (_, index) => f.claim({ id: `c${index}`,
      perspective: { ...f.claim().perspective, anchors: roleAnchors } }));
    const prepared = prepareWorldDrafts({ ...f.response(), claims }, f.input, f.context);
    expect(prepared.drafts).toHaveLength(25);
    expect(prepared.dropped).toEqual([25, 26, 27].map(index => ({ reason: "invalid_claim", id: `c${index}` })));
    expect(prepared.drafts.reduce((count, draft) => count + draft.semantic.anchors.length +
      draft.semantic.perspective.anchors.length, 0)).toBe(250);
  });

  test("an overflowed classification cannot authorize a later dependent sibling", () => {
    const f = fixture();
    const asserted = { holder: null, speaker: null, addressee: null,
      mode: "asserted" as const, interpretation: "explicit" as const, anchors: [] };
    // Raw: 51 * 4 + 2 + 1 = 207 anchors, below the parser's 256 cap.
    // Post-guard: each reported filler gains its one sent window, reaching 255.
    const fillers = Array.from({ length: 51 }, (_, index) => f.claim({ id: `fill-${index}`,
      predicate: "employment.role" }));
    const classification = f.claim({ id: "overflow-kind", predicate: "world.kind",
      object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } },
      perspective: asserted, anchors: [f.name, f.fact] });
    const dependent = f.claim({ id: "dependent", object: { kind: "literal", value: "Priya" },
      body: "Priya", perspective: asserted, anchors: [f.name] });
    const response = { ...f.response(), claims: [...fillers, classification, dependent] };
    const parserInput = { ...f.input, vocabulary_refs: ["world/concept"], predicates: [
      { id: "employment.role", object_kinds: ["literal" as const] },
      { id: "world.kind", object_kinds: ["vocabulary" as const] },
      { id: "concept.definition", object_kinds: ["literal" as const] },
    ] };
    const { budget: _budget, ...parseInput } = parserInput;
    const parsed = parseExtractResponseV2(JSON.stringify(response), parseInput);
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(parsed.ok).toBe(true);
    let classified = false;
    const prepared = prepareWorldDrafts(parsed.response, parserInput, { ...f.context, admits: value => {
        if (value.predicate === "world.kind") { classified = true; return true; }
        return value.predicate !== "concept.definition" || classified;
      } });
    expect(prepared.drafts.map(draft => draft.body)).toHaveLength(51);
    expect(prepared.dropped).toEqual([
      { reason: "invalid_claim", id: "overflow-kind" },
      { reason: "invalid_claim", id: "dependent" },
    ]);
    expect(classified).toBe(false);
  });

  test("repair is deduplicated and produces stable semantic and support identities", () => {
    const f = fixture();
    const first = semantic(f), second = semantic(f);
    const already = semantic(f, f.claim({ perspective: { ...f.claim().perspective,
      anchors: [f.name, f.role, { event_id: eventId, start_utf16: 0, end_utf16: f.text.length }] } }));
    expect(second).toEqual(first);
    expect(already).toEqual(first);
    expect(semanticKey(second)).toBe(semanticKey(first));
    const key = (value: ClaimV2Assertion) => supportKey({ semantic_key: semanticKey(value), source_key: sourceKey,
      grant_revision: 1, events: [{ event_id: eventId, event_content_hash: identity.content_hash }],
      anchors: [...value.anchors, ...value.perspective.anchors] });
    expect(key(second)).toBe(key(first));
    expect(key(already)).toBe(key(first));
  });
});
