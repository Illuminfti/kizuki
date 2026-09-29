/**
 * Seed a world claim set for any kind, from predicates alone.
 *
 * `worldSeed` generalizes `worldFixture` (which stays as it is): with the
 * default options it stores the same event and claims for a Concept or a
 * Situation. A new kind passes its own predicate list once the vocabulary
 * admits it; until then the writer's refusal surfaces as a `WorldSeedError`
 * that names the predicate, never as a half-seeded ledger.
 */
import type { Database } from "bun:sqlite";
import { OWNER } from "../../src/agents";
import { insertClaim } from "../../src/claims/store";
import { mintOccurrenceId } from "../../src/claims/occurrences";
import type { ClaimV2Assertion, ClaimV2Object } from "../../src/contracts/claim-v2";
import type { RetrievalPort } from "../../src/contracts/retrieval";
import { WORLD_ADMISSION_SCHEMA } from "../../src/contracts/world-admission";
import { registerConnection } from "../../src/ledger/connections";
import { accept } from "../../src/ledger/ledger";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { readWorldView } from "../../src/serving/world-view";
import type { ServeContext } from "../../src/serving/types";
import { seedConnectorSensitivity } from "../../src/sensitivity/store";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import type { TestClock } from "./clock";

export interface SeedPredicate {
  readonly predicate: string;
  readonly object: ClaimV2Object;
  readonly polarity?: "positive" | "negative";
}

export interface WorldSeedOptions {
  /** Kind id. Concept and Situation are admitted today. */
  readonly kind?: string;
  readonly subject?: string;
  readonly label?: string;
  readonly floor?: "public" | "private";
  readonly connector?: string;
  /** Reuse an enrolled source instead of registering a new one. */
  readonly sourceKey?: string;
  readonly perspectiveEvidence?: boolean;
  readonly retrieval?: RetrievalPort;
  readonly occurrence?: boolean;
  /** Claims stored after `world.kind` and the label. Defaults to the kind's one definition claim. */
  readonly predicates?: readonly SeedPredicate[];
  /** Drives `asserted_at` of every claim; the wall clock when absent. */
  readonly clock?: TestClock;
  /** Discover the seeded object by label to fill `ref`. Default: true for Concept and Situation. */
  readonly discover?: boolean;
}

export interface WorldSeed {
  readonly ctx: ServeContext;
  readonly sourceKey: string;
  readonly eventId: string;
  /** Claim ids in write order: `world.kind`, the label, then the predicates. */
  readonly claims: readonly string[];
  /** Wire ref of the seeded object as the owner sees it, or null when discovery is not offered for the kind. */
  readonly ref: { readonly kind: "object"; readonly token: string } | null;
  readonly kind: string;
  readonly label: string;
}

export class WorldSeedError extends Error {
  override readonly name = "WorldSeedError";
}

const DEFINITION = "Revise beliefs using evidence";
const DEFAULT_DEFINITION: Readonly<Record<string, string>> = {
  concept: "concept.definition",
  situation: "situation.objective",
};

/** The claims `worldFixture` stores for a kind, after `world.kind` and the label. */
function defaultPredicates(kind: string): readonly SeedPredicate[] {
  const predicate = DEFAULT_DEFINITION[kind];
  return predicate === undefined ? [] : [{ predicate, object: { kind: "literal", value: DEFINITION } }];
}

function bodyOf(predicate: string, object: ClaimV2Object): string {
  return `${predicate}: ${JSON.stringify(object)}`;
}

export async function worldSeed(db: Database, options: WorldSeedOptions = {}): Promise<WorldSeed> {
  const kind = options.kind ?? "concept",
    subject = options.subject ?? "topic:bayes",
    label = options.label ?? "Bayesian updating",
    floor = options.floor ?? "public",
    connector = options.connector ?? "world.fixture",
    sourceKey = options.sourceKey ?? ulid();
  if (options.sourceKey === undefined) {
    registerConnection(db, connector, sourceKey);
    seedConnectorSensitivity(
      db,
      { connector_id: connector, source_key: sourceKey },
      { default_sensitivity: floor, sensitivity_floor: floor },
    );
    setSourceGrant(db, {
      source_key: sourceKey,
      expected_revision: 0,
      operation_id: `grant-${sourceKey}`,
      policy: {
        purposes: ["capture", "derive", "recall", "correction", "export"],
        allowed_fields: ["text", "subjects", "metadata", "attachments"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        sensitivity_floor: floor,
      },
    });
  }
  const accepted = accept(
    db,
    {
      ...validEvent(),
      connector_id: connector,
      source_record_id: ulid(),
      kind: "note",
      text: `${label} means revising beliefs using evidence.`,
      sensitivity_hint: floor,
      subjects: [{ subject_id: subject, role: "about" }],
    },
    { source: { source_key: sourceKey, expected_revision: 1 } },
  );
  if (accepted.status !== "stored") throw new WorldSeedError(`event was not stored: ${JSON.stringify(accepted)}`);
  const event = accepted.event;
  const claims: string[] = [];
  const specs: readonly SeedPredicate[] = [
    { predicate: "world.kind", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: `world/${kind}` } } },
    { predicate: `${kind}.label`, object: { kind: "literal", value: label } },
    ...(options.predicates ?? defaultPredicates(kind)),
  ];
  for (const { predicate, object, polarity } of specs) {
    const semantic: ClaimV2Assertion = {
      schema: "kizuki.claim/v2",
      discriminator: "assertion",
      subject: options.occurrence
        ? {
            kind: "occurrence",
            id: mintOccurrenceId({ ...event, accepted_at: "" }, sourceKey, {
              event_id: event.event_id,
              start_utf16: 0,
              end_utf16: label.length,
            }),
          }
        : { kind: "supplied", id: subject, namespace: { connector_id: connector, source_key: sourceKey } },
      predicate,
      object,
      perspective: {
        holder: null,
        speaker: null,
        addressee: null,
        mode: "asserted",
        interpretation: "explicit",
        anchors: options.perspectiveEvidence
          ? [{ event_id: event.event_id, start_utf16: label.length, end_utf16: event.text.length }]
          : [],
      },
      context: [],
      polarity: polarity ?? "positive",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_to: null,
      temporal_basis: "explicit",
      anchors: [{ event_id: event.event_id, start_utf16: 0, end_utf16: label.length }],
    };
    const body = bodyOf(predicate, object);
    let stored;
    try {
      stored = await insertClaim(
        {
          db,
          ...(options.retrieval === undefined ? {} : { retrieval: options.retrieval }),
          ...(options.clock === undefined ? {} : { now: options.clock.now }),
        },
        {
          kind: "claim",
          body,
          provenance: [event.event_id],
          producer: "deterministic",
          confidence: 0.8,
          sensitivity: floor,
          subjects: [subject],
          semantic,
          world_admission: {
            schema: WORLD_ADMISSION_SCHEMA,
            semantic,
            rendering: { body, frontmatter: {} },
            authority: "model_inference",
            confidence: 0.5,
            epistemicKind: "model_inference",
          },
        },
      );
    } catch (error) {
      throw new WorldSeedError(`the writer refused ${predicate} for kind ${kind}`, { cause: error });
    }
    if (stored.outcome !== "stored" && stored.outcome !== "duplicate") {
      throw new WorldSeedError(`${predicate} was not stored: ${stored.outcome}`);
    }
    claims.push(stored.claim.claim_id);
  }
  const ctx: ServeContext = { db, vaultPath: "/tmp/world-fixture", principal: OWNER };
  let ref: WorldSeed["ref"] = null;
  const operation = kind === "concept" ? "find_concepts" : kind === "situation" ? "find_situations" : null;
  if (operation !== null && options.discover !== false) {
    const discovery = readWorldView(ctx, {
      operation,
      label,
      valid: { kind: "all" },
      knownAt: { kind: "current" },
    });
    if ("status" in discovery || discovery.result.status === "unavailable" || !("matches" in discovery.result.data)) {
      throw new WorldSeedError("discovery was unavailable for the seeded object");
    }
    ref = discovery.result.data.matches[0]?.ref ?? null;
    if (ref === null) throw new WorldSeedError("the seeded object was not discovered");
  }
  return { ctx, sourceKey, eventId: event.event_id, claims, ref, kind, label };
}
