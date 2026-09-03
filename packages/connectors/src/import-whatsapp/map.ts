import type { AttachmentRef, CaptureEventInput } from "@kizuki/core";
import { resolveSensitivity } from "../sensitivity";
import type { SensitivityPolicy } from "../sensitivity";
import { mediaTypeFor, subjectSlug } from "../util";
import { localToUtc } from "./dates";
import type { DateOrder } from "./dates";
import { splitWhatsAppMessages } from "./grammar";
import type { ParsedWhatsAppMessage } from "./grammar";
import { detectMedia } from "./media";
import type { MediaLookup } from "./media";

export const WHATSAPP_IMPORT_CONNECTOR_ID = "kizuki.import-whatsapp" as const;

/**
 * A personal chat, and an export cannot tell a group from a direct
 * conversation, so the stricter label wins. Nothing in a chat export is
 * public, so the floor is the label a shared reading list would get.
 */
export const WHATSAPP_SENSITIVITY: SensitivityPolicy = {
  default_sensitivity: "private",
  sensitivity_floor: "personal",
};

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
 * One segment after the namespace, so the handle a subject id yields is the
 * name a person would read and the id is one an owner can type into a purge.
 * A slug is lossy — that is what makes it readable — so two display names that
 * shorten to one handle are one subject, and an export carries nothing else to
 * tell them apart. The README says so.
 */
function subjectIdFor(namespace: string, name: string): string {
  return `${namespace}:${subjectSlug(name)}`;
}

/**
 * `whatsapp:self` is the owner: an export names every participant by whatever
 * they set on their own profile, so which of those names is the owner's comes
 * from configuration rather than from the file.
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
  const sensitivity_hint = resolveSensitivity(WHATSAPP_SENSITIVITY);
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
      sensitivity_hint,
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
