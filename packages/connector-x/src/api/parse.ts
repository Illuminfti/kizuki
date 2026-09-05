import { validateEventInput, type AttachmentRef, type CaptureEventInput, type SubjectRef } from "@kizuki/core";
import { MAX_PAGE_POSTS, X_API_CONNECTOR_ID, digest, failure, id, instant, object, token, type XApiSelection } from "./state";

export const MAX_POST_TEXT_BYTES = 128 * 1024;
export const MAX_API_BATCH_BYTES = 3 * 1024 * 1024;
function text(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_POST_TEXT_BYTES) throw failure();
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw failure();
  return value;
}
function optionalObject(value: unknown): Record<string, unknown> | null { return value === undefined ? null : object(value); }
function url(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 2048 || /[\x00-\x20\x7f]/.test(value)) throw failure();
  try {
    const parsed = new URL(value);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw failure();
  } catch { throw failure(); }
  return value;
}
function aliased<T>(raw: Record<string, unknown>, modern: string, legacy: string, parse: (value: unknown) => T): T | null {
  const a = raw[modern], b = raw[legacy];
  if (a === undefined && b === undefined) return null;
  const parsed = parse(a !== undefined ? a : b);
  if (a !== undefined && b !== undefined && digest(parsed) !== digest(parse(b))) throw failure();
  return parsed;
}
function entities(raw: unknown, selected: XApiSelection): { mentions: string[]; urls: string[] } {
  const value = optionalObject(raw);
  const mentions = selected.fields.includes("relationships") && value?.mentions !== undefined ?
    array(value.mentions, 64).map(item => id(object(item).id)) : [];
  const urls = selected.fields.includes("links") && value?.urls !== undefined ?
    array(value.urls, 32).map(item => url(object(item).expanded_url)) : [];
  return { mentions: [...new Set(mentions)], urls: [...new Set(urls)] };
}
interface MediaRef { media_key: string; kind: "photo" | "video" | "animated_gif"; url: string | null; preview_url: string | null }
function mediaKey(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]{1,4}_[0-9]{1,20}$/.test(value)) throw failure();
  return value;
}
function mediaRefs(raw: Record<string, unknown>, selected: XApiSelection): Map<string, MediaRef> {
  const result = new Map<string, MediaRef>();
  if (!selected.fields.includes("media")) return result;
  const included = optionalObject(raw.includes);
  for (const item of included?.media === undefined ? [] : array(included.media, MAX_PAGE_POSTS * 16)) {
    const value = object(item), key = mediaKey(value.media_key);
    if (!["photo", "video", "animated_gif"].includes(String(value.type)) || result.has(key)) throw failure();
    result.set(key, { media_key: key, kind: value.type as MediaRef["kind"], url: value.url === undefined ? null : url(value.url),
      preview_url: value.preview_image_url === undefined ? null : url(value.preview_image_url) });
  }
  return result;
}
function mapPost(raw: unknown, account: string, selected: XApiSelection, observed: string, media: Map<string, MediaRef>): CaptureEventInput {
  const value = object(raw), postId = id(value.id), author = id(value.author_id);
  if (author !== account) throw failure("identity_mismatch");
  if (value.withheld !== undefined) throw failure("partial_response");
  const baseText = text(value.text);
  const note = aliased(value, "note_post", "note_tweet", raw => {
    const note = object(raw); return { text: text(note.text), entities: entities(note.entities ?? value.entities, selected) };
  });
  const relation = selected.fields.includes("relationships");
  const refs = relation ? aliased(value, "referenced_posts", "referenced_tweets", raw => array(raw, 3).map(item => {
    const ref = object(item);
    if (!["retweeted", "quoted", "replied_to"].includes(String(ref.type))) throw failure();
    return { id: id(ref.id), type: String(ref.type) };
  })) ?? [] : [];
  const edits = aliased(value, "edit_history_post_ids", "edit_history_tweet_ids", raw => array(raw, 16).map(id)) ?? [postId];
  if (!edits.includes(postId) || edits.length === 0 || new Set(edits).size !== edits.length) throw failure();
  const includedEntities = note?.entities ?? entities(value.entities, selected);
  const reply = relation && value.in_reply_to_user_id !== undefined ? id(value.in_reply_to_user_id) : null;
  const subjects: SubjectRef[] = [{ subject_id: `x:user:${account}`, role: "from" }];
  if (reply !== null && reply !== account) subjects.push({ subject_id: `x:user:${reply}`, role: "to" });
  for (const mention of includedEntities.mentions) if (mention !== account) subjects.push({ subject_id: `x:user:${mention}`, role: "about" });
  const attached = selected.fields.includes("media") ? optionalObject(value.attachments) : null;
  const keys = attached?.media_keys === undefined ? [] : array(attached.media_keys, 16).map(mediaKey);
  if (new Set(keys).size !== keys.length || keys.some(key => !media.has(key))) throw failure("partial_response");
  const attachments: AttachmentRef[] = keys.map(key => ({ attachment_id: key, media_type: "application/octet-stream" }));
  const event: CaptureEventInput = {
    schema: "kizuki.event/v1", connector_id: X_API_CONNECTOR_ID, source_record_id: `post:${postId}`, kind: "post",
    occurred_at: instant(value.created_at), observed_at: instant(observed), text: note?.text ?? baseText,
    subjects, sensitivity_hint: "private", deleted: false, attachments,
    metadata: { source: "x_api", wire_profile: selected.wire_profile, account_id: account, post_id: postId, edit_history_ids: edits,
      ...(relation ? { references: refs, in_reply_to_user_id: reply } : {}),
      ...(selected.fields.includes("links") ? { urls: includedEntities.urls } : {}),
      ...(selected.fields.includes("media") ? { media_refs: keys.map(key => ({ ...media.get(key)! })) } : {}) },
  };
  const valid = validateEventInput(event);
  if (!valid.ok) throw failure();
  return valid.value;
}
export interface XApiPage { events: CaptureEventInput[]; next: string | null; newest: string | null }
/** Project bounded API-shaped records; no provider error prose or expanded foreign post text escapes. */
export function parsePage(raw: unknown, account: string, selected: XApiSelection, observed: string, mode: "timeline" | "lookup" = "timeline"): XApiPage {
  const value = object(raw); id(account); instant(observed);
  if (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length !== 0)) throw failure("partial_response");
  const rows = value.data === undefined ? [] : array(value.data, MAX_PAGE_POSTS);
  const meta = value.meta === undefined && mode === "lookup" ? { result_count: rows.length } : object(value.meta);
  if (meta.result_count !== rows.length) throw failure("partial_response");
  const media = mediaRefs(value, selected);
  const events = rows.map(row => mapPost(row, account, selected, observed, media));
  const ids = events.map(event => event.source_record_id.slice(5));
  if (new Set(ids).size !== ids.length) throw failure();
  const sortedIds = [...ids].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  const newest = sortedIds.at(-1) ?? null;
  if (meta.newest_id !== undefined && id(meta.newest_id) !== newest || meta.oldest_id !== undefined && id(meta.oldest_id) !== (sortedIds[0] ?? null)) throw failure();
  const next = meta.next_token === undefined ? null : token(meta.next_token);
  if (mode === "lookup" && next !== null) throw failure();
  events.sort((a, b) => BigInt(a.source_record_id.slice(5)) < BigInt(b.source_record_id.slice(5)) ? -1 : 1);
  if (Buffer.byteLength(JSON.stringify(events)) > MAX_API_BATCH_BYTES) throw failure("batch_limit");
  return { events, next, newest };
}
export function parseAccount(raw: unknown): string {
  const value = object(raw);
  if (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length !== 0)) throw failure("partial_response");
  return id(object(value.data).id);
}
