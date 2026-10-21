import type { Database } from "bun:sqlite";
import { prepareClaimInsert, type PreparedClaimInsert, type InsertClaimInput } from "../claims/store";
import { artifactSubjectId } from "../contracts/artifact-metadata";
import type { ClaimV2Assertion } from "../contracts/claim-v2";
import { readEvent } from "../ledger/ledger";
import { readRailCursor, writeRailCursor } from "../ledger/checkpoints";
import { artifactMetadataForEvent } from "./artifact-binding";
import type { WorldJob } from "../serve/world-jobs";

/** Import through the existing admission writer, without a model or canon write. */
export async function admitArtifactMetadata(db: Database, eventId: string): Promise<boolean> {
  const bound = artifactMetadataForEvent(db, eventId);
  if (!bound) return false;
  const event = readEvent(db, eventId);
  if (!event || event.text.length === 0) return false;
  const metadata = bound.metadata;
  const namespace = { connector_id: event.connector_id, source_key: bound.sourceKey };
  const subject = { kind: "supplied" as const, id: artifactSubjectId(metadata.sha256), namespace };
  const literal = (value: string) => ({ kind: "literal" as const, value });
  const values: [string, ClaimV2Assertion["object"]][] = [
    ["world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/artifact_version" } }],
    ["artifact.label", literal(`Artifact ${metadata.sha256.slice(0, 12)}`)],
    ["artifact.content_sha256", literal(metadata.sha256)],
    ["artifact.media_type", literal(metadata.mediaType)],
    ["artifact.byte_length", literal(String(metadata.byteLength))],
  ];
  if (metadata.versionOf !== null) {
    values.push(["artifact.version_of", { kind: "subject", ref: { kind: "supplied", id: metadata.versionOf, namespace } }]);
  }
  const prepared: PreparedClaimInsert[] = [];
  for (const [predicate, object] of values) {
    const semantic: ClaimV2Assertion = {
      schema: "kizuki.claim/v2", discriminator: "assertion", subject, predicate, object,
      perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
      context: [], polarity: "positive", valid_from: event.occurred_at, valid_to: null, temporal_basis: "explicit",
      anchors: [{ event_id: eventId, start_utf16: 0, end_utf16: event.text.length }],
    };
    const body = `${predicate}: ${object.kind === "literal" ? object.value : "captured artifact metadata"}`;
    const input: InsertClaimInput = {
      kind: "claim", body, provenance: [eventId], producer: "deterministic", confidence: 1, semantic,
      world_admission: {
        schema: "kizuki.world-admission/v1", semantic, rendering: { body, frontmatter: {} },
        authority: "model_inference", confidence: 1, epistemicKind: "model_inference",
      },
    };
    prepared.push(await prepareClaimInsert({ db }, input));
  }
  db.transaction(() => { for (const item of prepared) item.apply(); }).immediate();
  return true;
}

/** A bounded cycling cursor revisits policy changes; the shared writer makes retries idempotent. */
export const artifactMetadataJob: WorldJob = {
  id: "artifact-metadata",
  async run(ctx) {
    const key = "artifact-metadata", after = readRailCursor(ctx.db, key, "events") ?? "";
    // Read only identifiers here. Metadata access follows the source grant check above.
    let rows = ctx.db.query<{ event_id: string }, [string]>(
      "SELECT event_id FROM events WHERE event_id>? ORDER BY event_id LIMIT 32",
    ).all(after);
    if (rows.length === 0 && after !== "") {
      rows = ctx.db.query<{ event_id: string }, []>("SELECT event_id FROM events ORDER BY event_id LIMIT 32").all();
    }
    for (const row of rows) {
      if (ctx.stopRequested()) return;
      await admitArtifactMetadata(ctx.db, row.event_id);
      ctx.db.transaction(() => writeRailCursor(ctx.db, key, "events", row.event_id)).immediate();
    }
  },
};
