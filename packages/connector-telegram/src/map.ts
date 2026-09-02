import { isRfc3339 } from "@kizuki/core";
import type {
  AttachmentRef,
  CaptureEventInput,
  SensitivityHint,
  SubjectRef,
} from "@kizuki/core";
import type { TelegramDialog, TelegramMessage, TelegramUser } from "./api";

export const TELEGRAM_CONNECTOR_ID = "kizuki.telegram" as const;
export const TELEGRAM_CONNECTOR_VERSION = "0.1.0" as const;

/** Terminal label for an account: handle first, then name, then bare id. */
export function userDisplay(user: TelegramUser): string {
  if (user.username !== undefined && user.username.length > 0) {
    return `@${user.username}`;
  }
  const name = [user.first_name, user.last_name]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" ")
    .trim();
  return name.length > 0 ? name : `user ${user.id}`;
}

function chatSubject(peerId: string): string {
  return `telegram:chat:${peerId}`;
}

function userSubject(userId: string): string {
  return `telegram:user:${userId}`;
}

function senderSubject(
  message: TelegramMessage,
  role: "from",
): SubjectRef | null {
  const sender = message.from;
  if (sender === undefined) return null;
  return {
    subject_id:
      sender.kind === "user"
        ? userSubject(sender.id)
        : chatSubject(sender.id),
    role,
    display_name: sender.display,
  };
}

/**
 * Telegram is a chat source, and RFC 0002 §8.2 puts that class at a `private`
 * default: a resolved label may be raised from there and never lowered, so no
 * dialog of the owner's own account is evidence to hand out more freely. A
 * public channel is no exception. Its posts may be published, but which
 * channels this account reads, and when, is not.
 */
const CHAT_HINT: SensitivityHint = "private";

function subjectsFor(
  message: TelegramMessage,
  dialog: TelegramDialog,
  self: TelegramUser,
): SubjectRef[] {
  const selfRef = (role: "from" | "to"): SubjectRef => ({
    subject_id: userSubject(self.id),
    role,
    display_name: userDisplay(self),
  });
  const peerRef = (role: "from" | "to"): SubjectRef => ({
    subject_id: userSubject(dialog.peer_id),
    role,
    display_name: dialog.title,
  });

  if (dialog.peer_type === "user") {
    return message.out
      ? [selfRef("from"), peerRef("to")]
      : [peerRef("from"), selfRef("to")];
  }

  const about: SubjectRef = {
    subject_id: chatSubject(dialog.peer_id),
    role: "about",
    display_name: dialog.title,
  };
  const sender = senderSubject(message, "from");
  if (sender !== null) return [sender, about];

  // An anonymous channel post or a group service-less post with no sender:
  // the chat itself is the closest honest author.
  const signature =
    dialog.peer_type === "channel" && message.post_author !== undefined
      ? message.post_author
      : dialog.title;
  return [
    { subject_id: chatSubject(dialog.peer_id), role: "from", display_name: signature },
    about,
  ];
}

/**
 * The instant, or `null` when the ledger would refuse it. Provider dates are
 * attacker-controlled: a Date cannot hold every number one can carry, and the
 * ones it can hold reach far past the four-digit years an RFC3339 timestamp
 * is made of. Either would fail the whole batch it arrived in, and because a
 * batch with an error withholds its checkpoint, the same page would be re-read
 * and fail again for as long as the connection lives.
 */
function occurredAt(date: number): string | null {
  if (!Number.isInteger(date)) return null;
  const instant = new Date(date * 1000);
  if (Number.isNaN(instant.getTime())) return null;
  const text = instant.toISOString();
  return isRfc3339(text) ? text : null;
}

/**
 * `null` for service messages (joins, pins, title changes): they carry no
 * owner-authored content and would only add noise to the ledger, and for a
 * record whose timestamp is not one the ledger accepts. One unusable record is
 * dropped rather than a whole batch lost.
 */
export function mapMessage(
  message: TelegramMessage,
  dialog: TelegramDialog,
  self: TelegramUser,
  observed_at: string,
): CaptureEventInput | null {
  if (message.service) return null;
  const occurred_at = occurredAt(message.date);
  if (occurred_at === null) return null;

  const attachments: AttachmentRef[] = [];
  if (message.attachment !== undefined) {
    const { attachment_id, media_type, filename, byte_size } =
      message.attachment;
    attachments.push({
      attachment_id,
      media_type,
      ...(filename === undefined ? {} : { filename }),
      ...(byte_size === undefined ? {} : { byte_size }),
    });
  }

  const forward = message.forward_from;
  return {
    schema: "kizuki.event/v1",
    connector_id: TELEGRAM_CONNECTOR_ID,
    source_record_id: `${message.peer_id}:${message.id}`,
    kind: "message",
    occurred_at,
    observed_at,
    text: message.text,
    subjects: subjectsFor(message, dialog, self),
    sensitivity_hint: CHAT_HINT,
    deleted: false,
    attachments,
    // Deliberately no view or forward counters: metadata is hashed, and a
    // volatile counter would fork history on every re-scan of the same message.
    metadata: {
      peer_id: message.peer_id,
      peer_type: dialog.peer_type,
      message_id: message.id,
      out: message.out,
      reply_to: message.reply_to ?? null,
      forward_from:
        forward === undefined
          ? null
          : {
              id: forward.id ?? null,
              name: forward.name ?? null,
              date: forward.date ?? null,
            },
      edit_date: message.edit_date ?? null,
      grouped_id: message.grouped_id ?? null,
      media_kind: message.media_kind ?? null,
      post_author: message.post_author ?? null,
    },
  };
}
