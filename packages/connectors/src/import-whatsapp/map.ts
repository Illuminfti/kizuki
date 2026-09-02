import type { AttachmentRef, CaptureEventInput } from "@kizuki/core";
import { mediaTypeFor, subjectSlug } from "../util";
import { localToUtc } from "./dates";
import type { DateOrder } from "./dates";
import { splitWhatsAppMessages } from "./grammar";
import type { ParsedWhatsAppMessage } from "./grammar";
import { detectMedia } from "./media";
import type { MediaLookup } from "./media";

export const WHATSAPP_IMPORT_CONNECTOR_ID = "kizuki.import-whatsapp" as const;

export interface WhatsAppParseOptions {
  date_order?: DateOrder;
  /** Already resolved to a zone name or a fixed offset. */
  timezone: string;
  self?: string;
  chat: string;
  observed_at: string;
  media: MediaLookup;
}

function digest(message: ParsedWhatsAppMessage): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${message.sender}\n${message.text}`)
    .digest("hex")
    .slice(0, 16);
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
  return `${message.local_timestamp}/${digest(message)}/${occurrence}`;
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
    const senderId =
      opts.self !== undefined && message.sender === opts.self
        ? "whatsapp:self"
        : `whatsapp:${subjectSlug(message.sender)}`;

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
          subject_id: `whatsapp:chat:${subjectSlug(opts.chat)}`,
          role: "about",
          display_name: opts.chat,
        },
      ],
      // A personal chat, and an export cannot tell a group from a direct
      // conversation, so the stricter label wins.
      sensitivity_hint: "private",
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
