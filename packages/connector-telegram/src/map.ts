import type {
  AttachmentRef,
  CaptureEventInput,
  SensitivityHint,
  SubjectRef,
} from "@kizuki/core";
import type { TelegramDialog, TelegramMessage, TelegramUser } from "./api";

export const TELEGRAM_CONNECTOR_ID = "kizuki.telegram" as const;

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

function hintFor(dialog: TelegramDialog): SensitivityHint {
  if (dialog.peer_type === "user") return "private";
  if (dialog.peer_type === "group") return "personal";
  return dialog.public ? "public" : "personal";
}

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
 * `null` for service messages (joins, pins, title changes): they carry no
 * owner-authored content and would only add noise to the ledger.
 */
export function mapMessage(
  message: TelegramMessage,
  dialog: TelegramDialog,
  self: TelegramUser,
  observed_at: string,
): CaptureEventInput | null {
  if (message.service) return null;

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
    occurred_at: new Date(message.date * 1000).toISOString(),
    observed_at,
    text: message.text,
    subjects: subjectsFor(message, dialog, self),
    sensitivity_hint: hintFor(dialog),
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
