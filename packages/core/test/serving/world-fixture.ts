import type { Database } from "bun:sqlite";
import { OWNER } from "../../src/agents";
import { insertClaim } from "../../src/claims/store";
import { mintOccurrenceId } from "../../src/claims/occurrences";
import type { ClaimV2Assertion } from "../../src/contracts/claim-v2";
import type { RetrievalPort } from "../../src/contracts/retrieval";
import { WORLD_ADMISSION_SCHEMA } from "../../src/contracts/world-admission";
import { registerConnection } from "../../src/ledger/connections";
import { accept } from "../../src/ledger/ledger";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { readWorldView } from "../../src/serving/world-view";
import { seedConnectorSensitivity } from "../../src/sensitivity/store";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";

export async function worldFixture(
  db: Database,
  options: {
    kind?: "concept" | "situation";
    subject?: string;
    label?: string;
    floor?: "public" | "private";
    connector?: string;
    sourceKey?: string;
    perspectiveEvidence?: boolean;
    retrieval?: RetrievalPort;
    occurrence?: boolean;
  } = {},
) {
  const sourceKey = options.sourceKey ?? ulid(),
    connector = options.connector ?? "world.fixture",
    kind = options.kind ?? "concept",
    subject = options.subject ?? "topic:bayes",
    label = options.label ?? "Bayesian updating";
  if (options.sourceKey === undefined) {
    registerConnection(db, connector, sourceKey);
    seedConnectorSensitivity(
      db,
      { connector_id: connector, source_key: sourceKey },
      {
        default_sensitivity: options.floor ?? "public",
        sensitivity_floor: options.floor ?? "public",
      },
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
        sensitivity_floor: options.floor ?? "public",
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
      sensitivity_hint: options.floor ?? "public",
      subjects: [{ subject_id: subject, role: "about" }],
    },
    { source: { source_key: sourceKey, expected_revision: 1 } },
  );
  if (accepted.status !== "stored") throw new Error(JSON.stringify(accepted));
  const event = accepted.event;
  const claims: string[] = [];
  for (const [predicate, object] of [
    [
      "world.kind",
      { kind: "vocabulary", ref: { kind: "vocabulary", id: `world/${kind}` } },
    ],
    [`${kind}.label`, { kind: "literal", value: label }],
    [
      kind === "concept" ? "concept.definition" : "situation.objective",
      { kind: "literal", value: "Revise beliefs using evidence" },
    ],
  ] as const) {
    const semantic: ClaimV2Assertion = {
      schema: "kizuki.claim/v2",
      discriminator: "assertion",
      subject: options.occurrence ? {
        kind: "occurrence",
        id: mintOccurrenceId({ ...event, accepted_at: "" }, sourceKey,
          { event_id: event.event_id, start_utf16: 0, end_utf16: label.length }),
      } : {
        kind: "supplied",
        id: subject,
        namespace: { connector_id: connector, source_key: sourceKey },
      },
      predicate,
      object,
      perspective: {
        holder: null,
        speaker: null,
        addressee: null,
        mode: "asserted",
        interpretation: "explicit",
        anchors: options.perspectiveEvidence
          ? [
              {
                event_id: event.event_id,
                start_utf16: label.length,
                end_utf16: event.text.length,
              },
            ]
          : [],
      },
      context: [],
      polarity: "positive",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_to: null,
      temporal_basis: "explicit",
      anchors: [
        { event_id: event.event_id, start_utf16: 0, end_utf16: label.length },
      ],
    };
    const stored = await insertClaim(
      { db },
      {
        kind: "claim",
        body: `${predicate}: ${JSON.stringify(object)}`,
        provenance: [event.event_id],
        producer: "deterministic",
        confidence: 0.8,
        sensitivity: options.floor ?? "public",
        subjects: [subject],
        semantic,
        world_admission: {
          schema: WORLD_ADMISSION_SCHEMA,
          semantic,
          rendering: {
            body: `${predicate}: ${JSON.stringify(object)}`,
            frontmatter: {},
          },
          authority: "model_inference",
          confidence: 0.5,
          epistemicKind: "model_inference",
        },
      },
    );
    if (stored.outcome !== "stored" && stored.outcome !== "duplicate")
      throw new Error("fixture insert not stored");
    claims.push(stored.claim.claim_id);
  }
  const ctx = { db, vaultPath: "/tmp/world-fixture", principal: OWNER };
  const discovery = readWorldView(ctx, {
    operation: kind === "concept" ? "find_concepts" : "find_situations",
    label,
    valid: { kind: "all" },
    knownAt: { kind: "current" },
  });
  if (
    "status" in discovery ||
    discovery.result.status === "unavailable" ||
    !("matches" in discovery.result.data)
  )
    throw new Error("fixture discovery unavailable");
  const ref = discovery.result.data.matches[0]?.ref;
  if (ref === undefined) throw new Error("fixture concept was not discovered");
  return { ctx, sourceKey, eventId: event.event_id, claims, ref, kind, label };
}
