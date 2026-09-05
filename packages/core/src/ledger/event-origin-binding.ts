import type { Database } from "bun:sqlite";
import { EVENT_LIMITS, type CaptureEvent } from "../contracts/event";
import { canonicalJson, sha256Hex } from "../util/hash";
import { isRfc3339 } from "../util/time";

export type OriginBindingKind = CaptureEvent["origin_binding_kind"];
export type OriginIdentity = Pick<CaptureEvent,
  "event_id" | "content_hash_version" | "content_hash" | "text_hash" | "origin">;

export function computeOriginBinding(event: OriginIdentity, acceptedAt: string,
  kind: OriginBindingKind, nativeRequestDigest: string | null,
): string {
  return sha256Hex(`kizuki.event-origin-binding/v1\0${canonicalJson({
    event_id: event.event_id, content_hash_version: event.content_hash_version,
    content_hash: event.content_hash, text_hash: event.text_hash, accepted_at: acceptedAt,
    origin: event.origin, kind, native_request_digest: nativeRequestDigest,
  })}`);
}

/** Only an exact persisted native referent supplies an admission proof. */
export function nativeRequestDigest(db: Database, eventId: string): string | null {
  using statement = db.prepare<{
    connector_id: string; origin: string; request_digest: string; recorded_at: string; filing_state: string;
    event_content_hash: string; content_hash: string; observed_at: string; source_bound: number;
  }, [string]>(`SELECT e.connector_id,n.origin,n.request_digest,n.recorded_at,n.filing_state,
      n.event_content_hash,e.content_hash,e.observed_at,
      EXISTS(SELECT 1 FROM source_event_bindings b WHERE b.event_id=n.event_id) AS source_bound
    FROM native_owner_evidence n LEFT JOIN events e ON e.event_id=n.event_id WHERE n.event_id=?`);
  const proof = statement.get(eventId);
  if (proof === null) return null;
  if (proof.connector_id !== "kizuki.owner" || proof.origin !== "correction" ||
      !/^[a-f0-9]{64}$/.test(proof.request_digest) || !isRfc3339(proof.recorded_at) || proof.recorded_at.length > EVENT_LIMITS.timestampBytes || proof.source_bound !== 0 ||
      proof.recorded_at !== proof.observed_at || !/^[a-f0-9]{64}$/.test(proof.event_content_hash) ||
      proof.event_content_hash !== proof.content_hash || !["recorded", "filed", "failed"].includes(proof.filing_state)) {
    throw new Error("native owner evidence is invalid");
  }
  return proof.request_digest;
}
