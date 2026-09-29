import type { Database } from "bun:sqlite";
import { insertClaim, type InsertClaimResult } from "../../src/claims/store";
import type { ClaimsIo } from "../../src/claims/store";
import type { ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { WORLD_ADMISSION_SCHEMA } from "../../src/contracts/world-admission";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { enrollSource } from "./world-seed";

export type WorldObjectSpec =
  | { readonly literal: string }
  | { readonly subject: string }
  | { readonly vocabulary: string };

export interface WorldWrite {
  readonly subject: string;
  readonly predicate: string;
  readonly object: WorldObjectSpec;
  readonly polarity?: "positive" | "negative";
  readonly mode?: ClaimV2Assertion["perspective"]["mode"];
}

const CONNECTOR = "world.writer";

/**
 * Synthetic writer at the shared insertion seam. It enrolls its source through
 * the F3 kit (`enrollSource`), so grants and the sensitivity floor cannot drift
 * from `worldSeed`. It stays a separate writer because `worldSeed` stores one
 * whole kind per call (`world.kind`, a label, definitions) for one subject,
 * while a registry test needs one arbitrary claim per call in a shared ledger.
 * Every subject is a supplied reference in one source namespace, so a test
 * names endpoints by plain strings and never touches occurrence minting.
 */
export function worldWriter(options: { readonly db?: Database; readonly io?: Omit<ClaimsIo, "db"> } = {}) {
  const db: Database = options.db ?? openLedger(":memory:");
  const sourceKey = enrollSource(db, CONNECTOR, "public");
  const namespace = { connector_id: CONNECTOR, source_key: sourceKey };
  const ref = (id: string) => ({ kind: "supplied" as const, id, namespace });

  async function write(spec: WorldWrite): Promise<InsertClaimResult> {
    const ids = [
      spec.subject,
      ...("subject" in spec.object ? [spec.object.subject] : []),
    ];
    const accepted = accept(
      db,
      {
        ...validEvent(),
        connector_id: CONNECTOR,
        source_record_id: ulid(),
        kind: "note",
        text: "Synthetic record used to anchor one world assertion.",
        sensitivity_hint: "public",
        subjects: [...new Set(ids)].map((subject_id) => ({
          subject_id,
          role: "about" as const,
        })),
      },
      { source: { source_key: sourceKey, expected_revision: 1 } },
    );
    if (accepted.status !== "stored") throw new Error(JSON.stringify(accepted));
    const semantic: ClaimV2Assertion = {
      schema: "kizuki.claim/v2",
      discriminator: "assertion",
      subject: ref(spec.subject),
      predicate: spec.predicate,
      object:
        "literal" in spec.object
          ? { kind: "literal", value: spec.object.literal }
          : "vocabulary" in spec.object
            ? {
                kind: "vocabulary",
                ref: { kind: "vocabulary", id: spec.object.vocabulary },
              }
            : { kind: "subject", ref: ref(spec.object.subject) },
      perspective: {
        holder: null,
        speaker: null,
        addressee: null,
        mode: spec.mode ?? "asserted",
        interpretation: "explicit",
        anchors: [],
      },
      context: [],
      polarity: spec.polarity ?? "positive",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_to: null,
      temporal_basis: "explicit",
      anchors: [
        { event_id: accepted.event.event_id, start_utf16: 0, end_utf16: 9 },
      ],
    };
    const body = `${spec.predicate}: ${JSON.stringify(spec.object)}`;
    return insertClaim(
      { db, ...options.io },
      {
        kind: "claim",
        body,
        provenance: [accepted.event.event_id],
        producer: "deterministic",
        confidence: 0.8,
        sensitivity: "public",
        subjects: [spec.subject],
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
  }

  return {
    db,
    sourceKey,
    namespace,
    ref,
    write,
    /** Classify an endpoint the way extraction does: a positive, asserted world.kind claim. */
    classify: (subject: string, vocabulary: string) =>
      write({ subject, predicate: "world.kind", object: { vocabulary } }),
    close: () => { if (options.db === undefined) db.close(); },
  };
}
