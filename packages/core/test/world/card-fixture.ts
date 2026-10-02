import type { Database } from "bun:sqlite";
import { OWNER } from "../../src/agents";
import { insertClaim } from "../../src/claims/store";
import type { ClaimV2Assertion } from "../../src/contracts/claim-v2";
import type { ConceptCard } from "../../src/contracts/concept-card";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { readWorldView, serveWorldView } from "@kizuki/core/world";
import type { ServeContext } from "../../src/serving/types";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { enrollSource } from "../helpers/world-seed";
import { tempVault } from "../helpers/vault";

export async function cardFixture(database?: Database) {
  const vault = tempVault("kizuki-card-"), db = database ?? openLedger(`${vault.path}/.kizuki/kizuki.db`);
  const connector = "card.fixture", sourceKey = enrollSource(db, connector, "public");
  const namespace = { connector_id: connector, source_key: sourceKey };
  const ref = (id: string) => ({ kind: "supplied" as const, id, namespace });
  const ctx: ServeContext = { db, vaultPath: vault.path, principal: OWNER };
  async function write(predicate: string, object: ClaimV2Assertion["object"], options: {
    subject?: string; polarity?: "positive" | "negative"; context?: string[];
    from?: string | null; until?: string | null; text?: string; metadata?: Record<string, unknown>;
    floor?: "public" | "private"; mode?: ClaimV2Assertion["perspective"]["mode"];
    speaker?: string;
    span?: { start: number; end: number };
  } = {}) {
    const subject = options.subject ?? "topic:bayes";
    const ids = [subject, ...(object.kind === "subject" ? [object.ref.id] : []), ...(options.context ?? []), ...(options.speaker ? [options.speaker] : [])];
    const result = accept(db, {
      ...validEvent(), connector_id: connector, source_record_id: ulid(), kind: "note",
      text: options.text ?? `Evidence for ${predicate}: ${JSON.stringify(object)}.`,
      sensitivity_hint: options.floor ?? "public", metadata: options.metadata ?? {},
      subjects: [...new Set(ids)].map((subject_id) => ({ subject_id, role: "about" as const })),
    }, { source: { source_key: sourceKey, expected_revision: 1 } });
    if (result.status !== "stored") throw new Error("card evidence was not stored");
    const semantic: ClaimV2Assertion = {
      schema: "kizuki.claim/v2", discriminator: "assertion", subject: ref(subject), predicate, object,
      perspective: { holder: null, speaker: options.speaker ? ref(options.speaker) : null, addressee: null,
        mode: options.mode ?? "asserted", interpretation: "explicit", anchors: options.speaker ? [{ event_id: result.event.event_id, start_utf16: 0, end_utf16: result.event.text.length }] : [] },
      context: (options.context ?? []).map(ref), polarity: options.polarity ?? "positive",
      valid_from: options.from === undefined ? "2026-01-01T00:00:00.000Z" : options.from,
      valid_to: options.until ?? null, temporal_basis: options.from === null ? "unknown" : "explicit",
      anchors: [{ event_id: result.event.event_id, start_utf16: options.span?.start ?? 0, end_utf16: options.span?.end ?? result.event.text.length }],
    };
    const body = `${predicate}: ${JSON.stringify(object)}`;
    const stored = await insertClaim({ db }, { kind: "claim", body, provenance: [result.event.event_id],
      producer: "deterministic", confidence: 0.8, sensitivity: options.floor ?? "public", subjects: ids, semantic,
      world_admission: { schema: "kizuki.world-admission/v1", semantic, rendering: { body, frontmatter: {} },
        authority: "model_inference", confidence: 0.5, epistemicKind: "model_inference" },
    });
    return { event: result.event, semantic, stored };
  }
  await write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } });
  await write("concept.label", { kind: "literal", value: "Bayesian updating" });
  const definition = await write("concept.definition", { kind: "literal", value: "Revise beliefs using evidence" });
  const input = (operation: string, own: Record<string, unknown>) => ({ operation, ...own, valid: { kind: "all" }, knownAt: { kind: "current" } });
  function find(reader = ctx) {
    const found = readWorldView(reader, input("find_concepts", { label: "Bayesian" }));
    if (!("result" in found) || found.result.status === "unavailable" || !("matches" in found.result.data)) throw new Error("card not discovered");
    return found.result.data.matches[0]!.ref;
  }
  function card(reader = ctx): ConceptCard {
    const result = serveWorldView(reader, input("concept", { concept: find(reader) })).data;
    if (!("result" in result) || result.result.status === "unavailable" || result.result.data.schema !== "kizuki.concept-card/v1") throw new Error("card unavailable");
    return result.result.data as ConceptCard;
  }
  return { db, ctx, sourceKey, ref, write, input, find, card, definition, dispose() { if (!database) db.close(); vault.dispose(); } };
}
