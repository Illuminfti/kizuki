import { expect, test } from "bun:test";
import { validateEventInput } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { mapMessage } from "../src/map";
import type { TelegramDialog, TelegramMessage, TelegramUser } from "../src/api";

const OBSERVED_AT = "2026-02-01T00:00:00.000Z";
const SELF: TelegramUser = {
  id: "1001",
  username: "ada",
  first_name: "ada",
  bot: false,
};

const PRIVATE: TelegramDialog = {
  peer_id: "1002",
  peer_type: "user",
  title: "grace",
  public: false,
  top_message_id: 4,
};
const GROUP: TelegramDialog = {
  peer_id: "-42",
  peer_type: "group",
  title: "acme planning",
  public: false,
  top_message_id: 12,
};
const PUBLIC_CHANNEL: TelegramDialog = {
  peer_id: "-100777",
  peer_type: "channel",
  title: "acme news",
  public: true,
  top_message_id: 20,
};
const PRIVATE_CHANNEL: TelegramDialog = {
  ...PUBLIC_CHANNEL,
  peer_id: "-100888",
  title: "acme internal",
  public: false,
};

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    peer_id: "1002",
    id: 1,
    date: Math.floor(Date.UTC(2026, 0, 2, 9, 0, 0) / 1000),
    text: "morning",
    out: false,
    service: false,
    ...overrides,
  };
}

function mapped(
  raw: TelegramMessage,
  dialog: TelegramDialog,
): CaptureEventInput {
  const event = mapMessage(raw, dialog, SELF, OBSERVED_AT);
  expect(event).not.toBeNull();
  const checked = validateEventInput(event);
  expect(checked.ok).toBe(true);
  return event as CaptureEventInput;
}

test("an incoming private message is from the peer and to the owner", () => {
  const event = mapped(message(), PRIVATE);
  expect(event.source_record_id).toBe("1002:1");
  expect(event.kind).toBe("message");
  expect(event.occurred_at).toBe("2026-01-02T09:00:00.000Z");
  expect(event.observed_at).toBe(OBSERVED_AT);
  expect(event.sensitivity_hint).toBe("private");
  expect(event.deleted).toBe(false);
  expect(event.subjects).toEqual([
    { subject_id: "telegram:user:1002", role: "from", display_name: "grace" },
    { subject_id: "telegram:user:1001", role: "to", display_name: "@ada" },
  ]);
});

test("an outgoing private message reverses the two roles", () => {
  const event = mapped(message({ out: true }), PRIVATE);
  expect(event.subjects).toEqual([
    { subject_id: "telegram:user:1001", role: "from", display_name: "@ada" },
    { subject_id: "telegram:user:1002", role: "to", display_name: "grace" },
  ]);
  expect(event.metadata["out"]).toBe(true);
});

test("a group message is from its sender and about the chat", () => {
  const event = mapped(
    message({
      peer_id: "-42",
      id: 10,
      from: { id: "1003", display: "linus", kind: "user" },
    }),
    GROUP,
  );
  expect(event.sensitivity_hint).toBe("personal");
  expect(event.subjects).toEqual([
    { subject_id: "telegram:user:1003", role: "from", display_name: "linus" },
    {
      subject_id: "telegram:chat:-42",
      role: "about",
      display_name: "acme planning",
    },
  ]);
});

test("a group message with no sender is attributed to the chat", () => {
  const event = mapped(message({ peer_id: "-42", id: 11 }), GROUP);
  expect(event.subjects[0]).toEqual({
    subject_id: "telegram:chat:-42",
    role: "from",
    display_name: "acme planning",
  });
});

test("a public channel post is public and signed by its author", () => {
  const event = mapped(
    message({ peer_id: "-100777", id: 20, post_author: "grace" }),
    PUBLIC_CHANNEL,
  );
  expect(event.sensitivity_hint).toBe("public");
  expect(event.subjects).toEqual([
    {
      subject_id: "telegram:chat:-100777",
      role: "from",
      display_name: "grace",
    },
    {
      subject_id: "telegram:chat:-100777",
      role: "about",
      display_name: "acme news",
    },
  ]);
  expect(event.metadata["post_author"]).toBe("grace");
});

test("a channel without a public handle stays personal", () => {
  const event = mapped(
    message({ peer_id: "-100888", id: 20 }),
    PRIVATE_CHANNEL,
  );
  expect(event.sensitivity_hint).toBe("personal");
});

test("a media-only message keeps empty text and one attachment reference", () => {
  const event = mapped(
    message({
      id: 3,
      text: "",
      attachment: {
        attachment_id: "5001",
        media_type: "application/pdf",
        filename: "agenda.pdf",
        byte_size: 2048,
      },
    }),
    PRIVATE,
  );
  expect(event.text).toBe("");
  expect(event.attachments).toEqual([
    {
      attachment_id: "5001",
      media_type: "application/pdf",
      filename: "agenda.pdf",
      byte_size: 2048,
    },
  ]);
});

test("a photo carries its media type and no filename", () => {
  const event = mapped(
    message({
      id: 21,
      attachment: { attachment_id: "7001", media_type: "image/jpeg" },
    }),
    PRIVATE,
  );
  expect(event.attachments).toEqual([
    { attachment_id: "7001", media_type: "image/jpeg" },
  ]);
});

test("unsupported media is recorded by kind and carries no attachment", () => {
  const event = mapped(
    message({ id: 22, text: "", media_kind: "MessageMediaPoll" }),
    PRIVATE,
  );
  expect(event.attachments).toEqual([]);
  expect(event.metadata["media_kind"]).toBe("MessageMediaPoll");
});

test("replies and forwards are preserved in metadata", () => {
  const event = mapped(
    message({
      id: 4,
      reply_to: 3,
      forward_from: { id: "1002", name: "grace", date: 1767344400 },
    }),
    PRIVATE,
  );
  expect(event.metadata["reply_to"]).toBe(3);
  expect(event.metadata["forward_from"]).toEqual({
    id: "1002",
    name: "grace",
    date: 1767344400,
  });
});

test("a service message is skipped", () => {
  expect(mapMessage(message({ service: true }), GROUP, SELF, OBSERVED_AT)).toBeNull();
});

test("metadata carries no volatile counters", () => {
  const event = mapped(message(), PRIVATE);
  expect(Object.keys(event.metadata).sort()).toEqual([
    "edit_date",
    "forward_from",
    "grouped_id",
    "media_kind",
    "message_id",
    "out",
    "peer_id",
    "peer_type",
    "post_author",
    "reply_to",
  ]);
});

test("a timestamp no clock can represent is skipped, not thrown over", () => {
  // The date is copied straight off the wire, and a Date it cannot hold raises
  // a RangeError that would take down the whole batch rather than one record.
  for (const date of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    8.64e15,
    -8.64e15,
    1.5,
  ]) {
    expect(mapMessage(message({ date }), PRIVATE, SELF, OBSERVED_AT)).toBeNull();
  }
});

test("the timestamps a clock can represent still map", () => {
  for (const date of [0, 1, 2_147_483_647, 8_640_000_000_000]) {
    const event = mapMessage(message({ date }), PRIVATE, SELF, OBSERVED_AT);
    expect(event?.occurred_at).toBe(new Date(date * 1000).toISOString());
  }
});

test("a display name the terminal would choke on is still copied verbatim", () => {
  // Evidence is not sanitised: the mapper keeps what the provider sent, and
  // only the surfaces that print it strip control sequences.
  const hostile = "grace\u001b]52;c;cGF5bG9hZA==\u0007";
  const event = mapped(message(), { ...PRIVATE, title: hostile });
  expect(event.subjects.map((subject) => subject.display_name)).toContain(
    hostile,
  );
});
