import { eventIdFromReference } from "../retrieval/ids";
import { stringArray } from "../vault/pages";
import type { CanonPage } from "../vault/pages";

/**
 * A capture already cited by a selected page is redundant. A newer revision
 * of the same source record is different evidence and must remain visible
 * until the receipted writer updates the page.
 */
export function eventsCitedByPages(
  pages: readonly CanonPage[],
  candidates: readonly string[],
): Set<string> {
  const cited = new Set(pages.flatMap(page => stringArray(page.data["sources"]).map(eventIdFromReference)));
  return new Set(candidates.filter(id => cited.has(id)));
}

export interface DeduplicableSource {
  event_id: string;
  connector_id: string;
  kind: string;
  occurred_at: string;
  source_record_id?: string;
  text_hash?: string;
  accepted_at?: string;
  metadata?: string;
}

const EXTERNAL_MESSAGE_ID_KEYS = [
  "message_id",
  "external_id",
  "msg_id",
  "slack_ts",
  "discord_message_id",
  "telegram_message_id",
  "canonical_message_id",
] as const;

const CHANNEL_SCOPE_KEYS = [
  "channel_id",
  "chat_id",
  "room_id",
  "thread_id",
  "conversation_id",
] as const;

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined || raw.length === 0 || raw === "{}") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function canonicalMessageKeys(source: DeduplicableSource): string[] {
  const keys: string[] = [];
  if (typeof source.source_record_id === "string" && source.source_record_id.length > 0) {
    keys.push(`rec:${source.connector_id}\0${source.source_record_id}`);
  }
  const meta = parseJsonObject(source.metadata);
  if (meta !== null) {
    let channel = "";
    for (const chKey of CHANNEL_SCOPE_KEYS) {
      const value = meta[chKey];
      if (typeof value === "string" && value.length > 0) {
        channel = value;
        break;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        channel = String(value);
        break;
      }
    }
    for (const idKey of EXTERNAL_MESSAGE_ID_KEYS) {
      const value = meta[idKey];
      const normalized = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
      if (normalized.length > 0) {
        keys.push(`msg:${source.connector_id}\0${channel}\0${normalized}`);
        if (typeof source.text_hash === "string" && source.text_hash.length > 0) {
          keys.push(`xmsg:${normalized}\0${source.text_hash}`);
        }
        break;
      }
    }
  }
  if (typeof source.text_hash === "string" && source.text_hash.length > 0) {
    keys.push(`dup:${source.connector_id}\0${source.kind}\0${source.occurred_at}\0${source.text_hash}`);
  }
  if (keys.length === 0) {
    keys.push(`ev:${source.event_id}`);
  }
  return keys;
}

interface AdmittedQuoteSlot<T extends { event_id: string }> {
  index: number;
  accepted_at: string;
  event_id: string;
  keys: string[];
  _phantom?: T;
}

/**
 * Folds duplicate captured messages (across multiple source_keys, re-imports,
 * or edited versions) before limit slicing while preserving the highest-scoring
 * rank position and upgrading in place to the latest accepted version.
 */
export class CanonicalQuoteCollector<T extends { event_id: string }> {
  private readonly byKey = new Map<string, AdmittedQuoteSlot<T>>();
  public folded = 0;

  admit(source: DeduplicableSource, chunk: T, target: T[], maxTotal: number): boolean {
    const keys = canonicalMessageKeys(source);
    let existing: AdmittedQuoteSlot<T> | undefined;
    for (const key of keys) {
      existing = this.byKey.get(key);
      if (existing !== undefined) break;
    }
    const acceptedAt = source.accepted_at ?? "";
    if (existing !== undefined) {
      this.folded += 1;
      const isNewer =
        acceptedAt > existing.accepted_at ||
        (acceptedAt === existing.accepted_at && source.event_id > existing.event_id);
      if (isNewer) {
        target[existing.index] = chunk;
        existing.accepted_at = acceptedAt;
        existing.event_id = source.event_id;
      }
      for (const key of keys) {
        if (!this.byKey.has(key)) {
          this.byKey.set(key, existing);
          existing.keys.push(key);
        }
      }
      return false;
    }
    if (target.length >= maxTotal) return false;
    const slot: AdmittedQuoteSlot<T> = {
      index: target.length,
      accepted_at: acceptedAt,
      event_id: source.event_id,
      keys: [...keys],
    };
    target.push(chunk);
    for (const key of keys) this.byKey.set(key, slot);
    return true;
  }
}
