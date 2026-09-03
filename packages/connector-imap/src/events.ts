import { isRfc3339 } from "@kizuki/core";
import type { AttachmentRef, CaptureEventInput } from "@kizuki/core";
import { collectSubjects } from "./addresses";
import { htmlToText } from "./mime/html";
import { headerValue } from "./mime/headers";
import { decodeHeaderText, parseMessage, partText } from "./mime/parse";
import type { ContentDisposition, ContentType, MimePart } from "./mime/parse";
import type { StructurePart } from "./mime/structure";
import { decodeModifiedUtf7 } from "./imap/utf7";
import {
  MAX_FILENAME_CHARS,
  MAX_FOLDER_NAME_CHARS,
  MAX_HEADER_VALUE_CHARS,
  MAX_TEXT_CODE_POINTS,
  stripControls,
} from "./text";

export const IMAP_CONNECTOR_ID = "kizuki.imap" as const;

export {
  MAX_DISPLAY_NAME_CHARS,
  MAX_FILENAME_CHARS,
  MAX_FOLDER_NAME_CHARS,
  MAX_HEADER_VALUE_CHARS,
  MAX_SUBJECTS,
  MAX_TEXT_CODE_POINTS,
  stripControls,
} from "./text";

/**
 * The one way a mailbox name becomes display text. A mailbox name comes from
 * the server, so it can carry terminal escapes; decoding it is not enough.
 */
export function folderLabel(wire: string): string {
  return stripControls(decodeModifiedUtf7(wire), MAX_FOLDER_NAME_CHARS);
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

export interface MessageEventInput {
  folderWire: string;
  folderDisplay: string;
  uidvalidity: number;
  uid: number;
  internaldate: string;
  size: number;
  raw: Uint8Array;
  section: "" | "HEADER";
  /** The parts of an oversized message, which its headers alone cannot name. */
  structure?: StructurePart[];
  observedAt: string;
}

/**
 * The two numeric fields come first so splitting the id back apart is
 * unambiguous even for a mailbox name containing a colon.
 */
export function recordId(
  folderWire: string,
  uidvalidity: number,
  uid: number,
): string {
  return `${uidvalidity}:${uid}:${folderWire}`;
}

export function parseInternalDate(text: string): string | null {
  const match =
    /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?\s*$/.exec(
      text,
    );
  if (match === null) return null;
  const month = MONTHS.indexOf((match[2] ?? "").toLowerCase());
  if (month === -1) return null;
  const zone = match[7] ?? "+0000";
  const offset =
    (zone.startsWith("-") ? -1 : 1) *
    (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  const utc = Date.UTC(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  const millis = utc - offset * 60_000;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/** An ISO string the ledger will accept, or null when it is out of range. */
function storable(iso: string | null): string | null {
  return iso !== null && isRfc3339(iso) ? iso : null;
}

function storableIso(millis: number): string | null {
  if (Number.isNaN(millis)) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : storable(date.toISOString());
}

function capHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_HEADER_VALUE_CHARS
    ? value.slice(0, MAX_HEADER_VALUE_CHARS)
    : value;
}

function walkParts(part: MimePart, into: MimePart[] = []): MimePart[] {
  into.push(part);
  for (const child of part.children) walkParts(child, into);
  return into;
}

/**
 * What deciding "this is an attachment" needs. A full capture reads it off the
 * parsed message and a header-only one off `BODYSTRUCTURE`; both answer the
 * same questions, so both go through one rule.
 */
interface AttachmentSource {
  path: string;
  contentType: ContentType;
  disposition: ContentDisposition | null;
}

function isAttachment(part: AttachmentSource): boolean {
  if (part.disposition?.type === "attachment") return true;
  // An enclosed message is an attachment whatever it claims: the walk never
  // recurses into one, so anything else would drop it from the event entirely.
  if (
    part.contentType.type === "message" &&
    part.contentType.subtype === "rfc822"
  ) {
    return true;
  }
  const named =
    part.disposition?.params["filename"] ?? part.contentType.params["name"];
  return named !== undefined && part.contentType.type !== "text";
}

function attachmentName(part: AttachmentSource, fallbacks: string[]): string {
  const raw =
    part.disposition?.params["filename"] ??
    part.contentType.params["name"] ??
    "";
  const decoded = decodeHeaderText(raw, fallbacks).replace(/[/\\]/g, "");
  return stripControls(decoded, MAX_FILENAME_CHARS);
}

function mediaType(part: AttachmentSource): string {
  const { type, subtype } = part.contentType;
  if (type.length === 0 || subtype.length === 0)
    return "application/octet-stream";
  return `${type}/${subtype}`;
}

/** Wire bodies are CRLF; the ledger stores text, not a transcript of framing. */
function normalizeBody(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

function bodyText(
  root: MimePart,
  fallbacks: string[],
): { text: string; hasHtml: boolean } {
  const parts = walkParts(root).filter((part) => part.children.length === 0);
  const hasHtml = parts.some(
    (part) =>
      part.contentType.type === "text" && part.contentType.subtype === "html",
  );
  const readable = parts.filter((part) => !isAttachment(part));
  const plain = readable.find(
    (part) =>
      part.contentType.type === "text" && part.contentType.subtype === "plain",
  );
  if (plain !== undefined) {
    return { text: normalizeBody(partText(plain, fallbacks)), hasHtml };
  }
  const html = readable.find(
    (part) =>
      part.contentType.type === "text" && part.contentType.subtype === "html",
  );
  if (html !== undefined) {
    return { text: htmlToText(partText(html, fallbacks)), hasHtml };
  }
  return { text: "", hasHtml };
}

export function messageEvent(input: MessageEventInput): CaptureEventInput {
  const fallbacks: string[] = [];
  const parsed = parseMessage(input.raw);
  const fields = parsed.headers;
  const subject = decodeHeaderText(
    headerValue(fields, "subject") ?? "",
    fallbacks,
  );

  const headerOnly = input.section === "HEADER";
  const body = headerOnly
    ? { text: "", hasHtml: false }
    : bodyText(parsed.root, fallbacks);

  const pieces = [subject, body.text].filter((piece) => piece.length > 0);
  let text = pieces.join("\n\n");
  const codePoints = Array.from(text);
  const truncated = codePoints.length > MAX_TEXT_CODE_POINTS;
  if (truncated) text = codePoints.slice(0, MAX_TEXT_CODE_POINTS).join("");

  const dateHeader = headerValue(fields, "date");
  const cleanedDate = (dateHeader ?? "")
    .replace(/\s*\([^()]*\)\s*$/, "")
    .trim();
  const parsedDate =
    cleanedDate.length > 0 ? Date.parse(cleanedDate) : Number.NaN;
  // A sender picks the `Date:` header, and a year the ledger cannot store
  // would fail the whole batch, so the fallback chain runs on what is
  // representable rather than on what merely parsed.
  const occurredAt =
    storableIso(parsedDate) ??
    storable(parseInternalDate(input.internaldate)) ??
    input.observedAt;

  const attachments: AttachmentRef[] = [];
  // An oversized multipart message has no bodies to walk, and its top-level
  // headers say nothing about the parts below them, so its refs come from the
  // structure the server described. Without one, the headers alone still
  // describe a single-part message honestly.
  const structure = input.structure ?? [];
  const sources: { part: AttachmentSource; bytes: number | null }[] =
    headerOnly && structure.length > 0
      ? structure.map((part) => ({ part, bytes: null }))
      : walkParts(parsed.root)
          .filter((part) => part.children.length === 0)
          .map((part) => ({
            part,
            bytes: headerOnly ? null : part.body.byteLength,
          }));
  for (const { part, bytes } of sources) {
    if (!isAttachment(part)) continue;
    const filename = attachmentName(part, fallbacks);
    attachments.push({
      // A single-part message is section 1 in IMAP terms, not the empty path.
      attachment_id: part.path.length === 0 ? "1" : part.path,
      media_type: mediaType(part),
      ...(filename.length > 0 ? { filename } : {}),
      ...(bytes === null ? {} : { byte_size: bytes }),
    });
  }

  const references = (headerValue(fields, "references") ?? "")
    .split(/\s+/)
    .filter(
      (reference) => reference.startsWith("<") && reference.endsWith(">"),
    );
  const listId = capHeader(headerValue(fields, "list-id"));

  // Collected before the metadata literal: decoding an address phrase can add
  // a charset fallback, and the label has to travel with the event that needed
  // it rather than be snapshotted a moment too early.
  const subjects = collectSubjects(fields, fallbacks);

  const transferFallbacks = [
    ...new Set(
      walkParts(parsed.root)
        .map((part) => part.transferFallback)
        .filter((label): label is string => label !== undefined),
    ),
  ].sort();

  const metadata: Record<string, unknown> = {
    folder: input.folderDisplay,
    uid: input.uid,
    uidvalidity: input.uidvalidity,
    message_id: capHeader(headerValue(fields, "message-id")) ?? null,
    in_reply_to: capHeader(headerValue(fields, "in-reply-to")) ?? null,
    references,
    date_header: capHeader(dateHeader) ?? null,
    internaldate: input.internaldate,
    size: input.size,
    has_html: body.hasHtml,
    ...(listId !== undefined ? { list_id: listId } : {}),
    ...(headerOnly ? { body_omitted: "size" } : {}),
    ...(truncated ? { text_truncated: true } : {}),
    ...(fallbacks.length > 0
      ? { charset_fallback: [...fallbacks].sort() }
      : {}),
    ...(transferFallbacks.length > 0
      ? { transfer_fallback: transferFallbacks }
      : {}),
    ...(parsed.headersTruncated ? { header_truncated: true } : {}),
  };

  return {
    schema: "kizuki.event/v1",
    connector_id: IMAP_CONNECTOR_ID,
    source_record_id: recordId(input.folderWire, input.uidvalidity, input.uid),
    kind: "email",
    occurred_at: occurredAt,
    observed_at: input.observedAt,
    text,
    subjects,
    sensitivity_hint: "personal",
    deleted: false,
    attachments,
    metadata,
  };
}

export function tombstoneEvent(input: {
  folderWire: string;
  folderDisplay: string;
  uidvalidity: number;
  uid: number;
  observedAt: string;
  uidvalidityReset?: boolean;
}): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: IMAP_CONNECTOR_ID,
    source_record_id: recordId(input.folderWire, input.uidvalidity, input.uid),
    kind: "email",
    occurred_at: input.observedAt,
    observed_at: input.observedAt,
    text: "",
    subjects: [],
    deleted: true,
    attachments: [],
    metadata: {
      folder: input.folderDisplay,
      uid: input.uid,
      uidvalidity: input.uidvalidity,
      ...(input.uidvalidityReset === true ? { uidvalidity_reset: true } : {}),
    },
  };
}
