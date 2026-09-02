import type { AttachmentRef, CaptureEventInput } from "@kizuki/core";
import { mediaTypeFor, subjectName, subjectSlug } from "../util";
import { localToUtc } from "./dates";
import type { DateOrder } from "./dates";
import { splitWhatsAppMessages } from "./grammar";
import type { ParsedWhatsAppMessage } from "./grammar";
import { detectMedia } from "./media";
import type { MediaLookup } from "./media";

export const WHATSAPP_IMPORT_CONNECTOR_ID = "kizuki.import-whatsapp" as const;

/**
 * A personal chat, and an export cannot tell a group from a direct
 * conversation, so the stricter label wins.
 */
const WHATSAPP_SENSITIVITY = "private" as const;

export interface WhatsAppParseOptions {
  date_order?: DateOrder;
  /** Already resolved to a zone name or a fixed offset. */
  timezone: string;
  self?: string;
  chat: string;
  observed_at: string;
  media: MediaLookup;
}

function digest(value: string, length: number): string {
  return new Bun.CryptoHasher("sha256")
    .update(value)
    .digest("hex")
    .slice(0, length);
}

/**
 * A slug is lossy on purpose — it has to read as a handle — so two names that
 * differ only in punctuation, and any two names with no letters or digits at
 * all, slug to one word. A subject id is what a purge reaches and what a
 * person page is filed under, so the readable slug carries a digest of the
 * name it was made from and two participants stay two people.
 */
function subjectIdFor(namespace: string, name: string): string {
  const comparable = subjectName(name);
  return `${namespace}:${subjectSlug(name)}-${digest(comparable, 8)}`;
}

/**
 * `whatsapp:self` is the owner, and only the owner: in a group chat every
 * other name is whatever that person set on their own profile, so the reserved
 * id is handed out from configuration rather than from what an export says.
 */
function senderSubjectId(sender: string, self: string | undefined): string {
  if (self !== undefined && sender === self) return "whatsapp:self";
  return subjectIdFor("whatsapp", sender);
}

/**
 * There are no message ids in an export, so identity is content-derived:
 * stable across exports whatever the position, and different for a message
 * edited between two exports, which is a new version rather than a deletion.
 */
function sourceRecordId(
  message: ParsedWhatsAppMessage,
  occurrence: number,
): string {
  return `${message.local_timestamp}/${digest(`${message.sender}\n${message.text}`, 16)}/${occurrence}`;
}

async function attachmentFor(
  filename: string,
  media: MediaLookup,
): Promise<AttachmentRef[]> {
  const found = await media(filename);
  if (found === null) return [];
  return [
    {
      attachment_id: filename,
      media_type: mediaTypeFor(filename),
      filename,
      byte_size: found.byte_size,
    },
  ];
}

export async function parseWhatsAppExport(
  text: string,
  opts: WhatsAppParseOptions,
): Promise<CaptureEventInput[]> {
  const { messages } = splitWhatsAppMessages(text, opts.date_order);
  const seen = new Map<string, number>();
  const events: CaptureEventInput[] = [];

  for (const message of messages) {
    const key = `${message.local_timestamp}\n${message.sender}\n${message.text}`;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);

    const media = detectMedia(message.text);
    const filename = media?.filename ?? null;
    const attachments =
      media?.kind === "file" && filename !== null
        ? await attachmentFor(filename, opts.media)
        : [];
    const senderId = senderSubjectId(message.sender, opts.self);

    events.push({
      schema: "kizuki.event/v1",
      connector_id: WHATSAPP_IMPORT_CONNECTOR_ID,
      source_record_id: sourceRecordId(message, occurrence),
      kind: "message",
      occurred_at: localToUtc(message.local_timestamp, opts.timezone),
      observed_at: opts.observed_at,
      text: message.text,
      subjects: [
        {
          subject_id: senderId,
          role: "from",
          display_name: message.sender,
        },
        {
          subject_id: subjectIdFor("whatsapp:chat", opts.chat),
          role: "about",
          display_name: opts.chat,
        },
      ],
      sensitivity_hint: WHATSAPP_SENSITIVITY,
      deleted: false,
      attachments,
      metadata: {
        chat: opts.chat,
        sender: message.sender,
        local_timestamp: message.local_timestamp,
        timezone: opts.timezone,
        media: media?.kind ?? null,
        filename,
      },
    });
  }

  return events;
}
