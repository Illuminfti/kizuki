import { modelQuoteWire } from "../producer/quote-wire-helper";
import { expect, test } from "bun:test";
import { OWNER } from "../../src/agents";
import { createBudgetTracker } from "../../src/canon/budget";
import { createWorldRegistry } from "../../src/contracts/world-kinds";
import { WORLD_VOCABULARY_MODULES, withWorldRegistry } from "../../src/contracts/world-vocabulary";
import type { ExtractResponseV2, ProduceInputV2 } from "../../src/contracts/producer-v2";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { bindSourceModelPort } from "../../src/ledger/source-grants";
import { createModelProducerV2Port, MODEL_PRODUCER_V2_DESCRIPTOR } from "../../src/producer/model-v2";
import { runWritePass } from "../../src/serve/write-pass";
import { serveWorldView } from "../../src/serving/world-view";
import { validEvent } from "../fixtures";
import { tempVault } from "../helpers/vault";
import { enrollSource } from "../helpers/world-seed";
import { FAKE_MODEL_REF, scriptedLlm, temporaryProducerContext } from "../producer/helpers";

const registry = createWorldRegistry(WORLD_VOCABULARY_MODULES.map(module => module.kind === null ? module :
  { ...module, kind: { ...module.kind, offeredToProducer: ["concept", "person", "question"].includes(module.kind.id) } }));
const binding = { model_endpoint: "https://models.example.test/v1/chat/completions", model: FAKE_MODEL_REF, external_retention: "provider_managed" as const };
const vocabulary = (id: string) => ({ kind: "vocabulary" as const, ref: { kind: "vocabulary" as const, id } });
const literal = (value: string) => ({ kind: "literal" as const, value });

/** Scripted LLM only. Capture, model adapter, parsing, consent, writer and public consumer are real. */
async function journey(kind: "person" | "question", occurrence: boolean, supplied: boolean) {
  const vault = tempVault("catalog-consumer-"), db = openLedger(`${vault.path}/.kizuki/kizuki.db`);
  const context = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR);
  const sourceKey = enrollSource(db, "catalog.fixture", "public", undefined, binding);
  const label = kind === "person" ? "Ivo" : "Which lens blocks glare?";
  const text = kind === "person" ? "Ivo is a conservator." : "The open question asks: Which lens blocks glare?";
  const accepted = accept(db, { ...validEvent(), connector_id: "catalog.fixture", source_record_id: "record-1", text,
    sensitivity_hint: "public", subjects: supplied ? [{ subject_id: `${kind}:ivo`, role: "about", display_name: label }] : [] },
    { source: { source_key: sourceKey, expected_revision: 1 } });
  if (accepted.status !== "stored") throw new Error("synthetic capture failed");
  let input: ProduceInputV2;
  const llm = scriptedLlm(request => {
    expect(request.messages[0]!.content).toContain('"person.role","person"');
    expect(request.messages[1]!.content).toContain(text);
    const start = text.indexOf(label), anchor = { event_id: input.events[0]!.event_id, start_utf16: start, end_utf16: start + label.length };
    const subject = { kind: occurrence ? "mention" as const : "supplied" as const, id: occurrence ? "m1" : input.supplied_refs[0]!.id };
    const response: ExtractResponseV2 = { schema: "kizuki.producer-response/v2", mentions: occurrence ? [
      { id: "m1", label, anchor, candidate_refs: supplied ? [{ kind: "supplied", id: input.supplied_refs[0]!.id }] : [] },
    ] : [], claims: [
      ["world.kind", vocabulary(`world/${kind}`)],
      [kind === "person" ? "person.label" : "question.text", literal(label)],
      kind === "person" ? ["person.role", literal("conservator")] : ["question.status", vocabulary("question/open")],
    ].map(([predicate, object], index) => ({ id: `c${index}`, subject, predicate: predicate as string,
      object: object as ExtractResponseV2["claims"][number]["object"],
      perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
      context: [], polarity: "positive", body: `${label}: ${String(predicate)}.`, valid_from: null, valid_to: null,
      temporal_basis: "unknown", confidence: 0.8, sensitivity: "public", anchors: [anchor] })) };
    return JSON.stringify(modelQuoteWire(response, input.events));
  });
  const actual = createModelProducerV2Port(context.ctx, { llm });
  const producer = bindSourceModelPort({ ...actual, async produce(value: ProduceInputV2) { input = value; return actual.produce(value); } }, binding);
  try {
    const pass = await runWritePass(db, vault.path, { producer, model_ref: FAKE_MODEL_REF, claims: { db }, budget: createBudgetTracker({ canon_writes_per_run: 8 }) });
    expect(pass.errors).toEqual([]);
    expect(llm.requests).toHaveLength(1);
    const ctx = { db, vaultPath: vault.path, principal: OWNER }, when = { valid: { kind: "all" }, knownAt: { kind: "current" } };
    const discovery = serveWorldView(ctx, { operation: kind === "person" ? "find_people" : "find_questions", label, ...when }).data;
    if (!("result" in discovery) || !("data" in discovery.result) || !("matches" in discovery.result.data)) throw new Error("public discovery unavailable");
    if (kind === "person" && occurrence) {
      expect(pass.claims_extracted).toBe(0);
      expect(discovery.result.data.matches).toEqual([]);
    } else {
      expect(pass.claims_extracted).toBe(3);
      expect(discovery.result.data.matches).toHaveLength(1);
      const card = serveWorldView(ctx, { operation: kind, [kind]: discovery.result.data.matches[0]!.ref, ...when }).data;
      expect(JSON.stringify(card)).toContain(kind === "person" ? "conservator" : "Which lens blocks glare?");
      expect(card).toHaveProperty("result.data.schema", `kizuki.${kind}-card/v1`);
      expect(db.query<{ kind: string }, []>("SELECT subject_kind AS kind FROM claim_v2_semantics LIMIT 1").get()?.kind).toBe(occurrence ? "occurrence" : "supplied");
    }
  } finally { await actual.close(); db.close(); vault.dispose(); context.cleanup(); }
}

test("typed Person uses structured source identity through the actual writer and consumer", () => withWorldRegistry(registry, () => journey("person", false, true)));
test("raw-name Person drafts cannot become a card even when the adapter accepts their JSON", () => withWorldRegistry(registry, () => journey("person", true, false)));
test("a nominated Question occurrence remains usable without silently becoming the supplied identity", () => withWorldRegistry(registry, () => journey("question", true, true)));
