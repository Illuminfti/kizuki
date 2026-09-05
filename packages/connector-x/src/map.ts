import { validateEventInput, isPlainObject } from "@kizuki/core";
import type { CaptureEventInput, SubjectRef } from "@kizuki/core";
import type { MediaEntry, XArchiveIdentity } from "./archive";
import { assertMediaStable } from "./archive";
import { archiveError } from "./errors";
import { nativeId, parseArchiveDate, postRecordId, userSubjectId } from "./ids";
import { requiredObject } from "./ytd";

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_URLS = 128;
const MAX_URL_BYTES = 8 * 1024;
const MAX_MENTIONS = 128;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function optionalNativeId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return nativeId(value, field);
}

function optionalString(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || byteLength(value) > maximum ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw archiveError("parse_error", `${field} is invalid`);
  }
  return value;
}

function urlsFrom(entities: Record<string, unknown> | null, where: string): string[] {
  const raw = entities?.["urls"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_URLS) {
    throw archiveError("parse_error", `${where}.entities.urls is invalid`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    const item = requiredObject(value, `${where}.entities.urls[${index}]`);
    const expanded = item["expanded_url"];
    if (typeof expanded !== "string" || expanded.length === 0 || byteLength(expanded) > MAX_URL_BYTES ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(expanded)) {
      throw archiveError("parse_error", `${where}.entities.urls[${index}].expanded_url is invalid`);
    }
    let parsed: URL;
    try {
      parsed = new URL(expanded);
    } catch {
      throw archiveError("parse_error", `${where}.entities.urls[${index}].expanded_url is invalid`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw archiveError("parse_error", `${where}.entities.urls[${index}].expanded_url uses an unsupported scheme`);
    }
    if (!seen.has(expanded)) {
      seen.add(expanded);
      result.push(expanded);
    }
  });
  return result;
}

function mentionsFrom(
  entities: Record<string, unknown> | null,
  where: string,
  selfId: string,
): SubjectRef[] {
  const raw = entities?.["user_mentions"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_MENTIONS) {
    throw archiveError("parse_error", `${where}.entities.user_mentions is invalid`);
  }
  const result: SubjectRef[] = [];
  const seen = new Set<string>([selfId]);
  raw.forEach((value, index) => {
    const item = requiredObject(value, `${where}.entities.user_mentions[${index}]`);
    const id = nativeId(item["id_str"] ?? item["id"], `${where}.entities.user_mentions[${index}].id`);
    if (seen.has(id)) return;
    seen.add(id);
    const username = optionalString(item["screen_name"], `${where}.entities.user_mentions[${index}].screen_name`, 64);
    result.push({
      subject_id: userSubjectId(id),
      role: "about",
      ...(username === null ? {} : { display_name: `@${username}` }),
    });
  });
  return result;
}

export interface MappedPost {
  event: CaptureEventInput;
  media: readonly MediaEntry[];
}

export function mapPost(
  raw: unknown,
  part: number,
  index: number,
  self: XArchiveIdentity,
  mediaByPost: ReadonlyMap<string, readonly MediaEntry[]>,
  observedAt: string | null,
): MappedPost {
  const where = `tweets part ${part} record ${index}`;
  const envelope = requiredObject(raw, where);
  const tweet = requiredObject(envelope["tweet"], `${where}.tweet`);
  const id = nativeId(tweet["id_str"] ?? tweet["id"], `${where} post id`);
  const textValue = tweet["full_text"] ?? tweet["text"];
  if (typeof textValue !== "string" || byteLength(textValue) > MAX_TEXT_BYTES) {
    throw archiveError("parse_error", `${where} text is missing or exceeds ${MAX_TEXT_BYTES} bytes`);
  }
  const occurredAt = parseArchiveDate(tweet["created_at"]);
  const entitiesValue = tweet["entities"];
  const entities = entitiesValue === undefined ? null :
    isPlainObject(entitiesValue) ? entitiesValue :
      (() => { throw archiveError("parse_error", `${where}.entities must be an object`); })();
  const urls = urlsFrom(entities, where);
  const mentions = mentionsFrom(entities, where, self.account_id);
  const inReplyToPostId = optionalNativeId(tweet["in_reply_to_status_id_str"], `${where}.in_reply_to_status_id_str`);
  const inReplyToUserId = optionalNativeId(tweet["in_reply_to_user_id_str"], `${where}.in_reply_to_user_id_str`);
  const lang = optionalString(tweet["lang"], `${where}.lang`, 32);
  const media = mediaByPost.get(id) ?? [];
  const selfSubject: SubjectRef = {
    subject_id: userSubjectId(self.account_id),
    role: "from",
    ...(self.username === null ? {} : { display_name: `@${self.username}` }),
  };
  const replySubject: SubjectRef[] = inReplyToUserId === null ||
    inReplyToUserId === self.account_id ? [] : [{ subject_id: userSubjectId(inReplyToUserId), role: "to" }];
  const event: CaptureEventInput = {
    schema: "kizuki.event/v1",
    connector_id: "kizuki.import-x-archive",
    source_record_id: postRecordId(id),
    kind: "post",
    occurred_at: occurredAt,
    observed_at: observedAt ?? occurredAt,
    text: textValue,
    subjects: [selfSubject, ...replySubject, ...mentions],
    sensitivity_hint: "personal",
    deleted: false,
    attachments: media.map((item) => ({
      attachment_id: item.filename,
      media_type: item.media_type,
      filename: item.filename,
      byte_size: item.byte_size,
    })),
    metadata: {
      source: "x_archive",
      dataset: "tweets",
      account_id: self.account_id,
      post_id: id,
      in_reply_to_post_id: inReplyToPostId,
      in_reply_to_user_id: inReplyToUserId,
      lang,
      urls,
    },
  };
  const valid = validateEventInput(event);
  if (!valid.ok) {
    throw archiveError("parse_error", `${where} cannot be represented by kizuki.event/v1`);
  }
  return { event: valid.value, media };
}

export async function verifyMappedMedia(mapped: readonly MappedPost[]): Promise<void> {
  await assertMediaStable(mapped.flatMap((item) => [...item.media]));
}
