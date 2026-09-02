import { beforeEach, expect, test } from "bun:test";
import type { TelegramDialog, TelegramMessage, TelegramUser } from "../src/api";
import { OFFLINE, api, drain, pages, reset } from "./fake-telegram";

beforeEach(reset);

test.skipIf(!OFFLINE)("dialogs arrive as the plain records the walk reads", async () => {
  pages.dialogs = async function* () {
    yield {
      entity: { id: "1002", firstName: "grace" },
      isUser: true,
      isGroup: false,
      message: { id: 5 },
    };
    yield {
      entity: { id: "-42", title: "acme planning" },
      isUser: false,
      isGroup: true,
      message: { id: 13 },
    };
    yield {
      entity: { id: "-100777", title: "acme news", username: "acmenews" },
      isUser: false,
      isGroup: false,
    };
    // A listing entry the response carried no entity for: there is no peer to
    // read, so it is dropped rather than guessed at.
    yield { entity: undefined, isUser: true, isGroup: false };
  };

  expect(await drain(api().dialogs(10))).toEqual([
    {
      peer_id: "1002",
      peer_type: "user",
      title: "grace",
      top_message_id: 5,
    },
    {
      peer_id: "-42",
      peer_type: "group",
      title: "acme planning",
      top_message_id: 13,
    },
    {
      peer_id: "-100777",
      peer_type: "channel",
      title: "acme news",
      top_message_id: 0,
    },
  ] satisfies TelegramDialog[]);
});

test.skipIf(!OFFLINE)("history arrives as the plain records the mapper reads", async () => {
  pages.messages = async function* () {
    yield {
      id: 7,
      date: 1767225600,
      message: "on my way",
      out: true,
      className: "Message",
      fromId: { id: "1003" },
      sender: { firstName: "linus" },
      postAuthor: "grace",
      replyToMsgId: 4,
      editDate: 1767225660,
      groupedId: { toString: () => "9001" },
      fwdFrom: { fromId: { id: "1002" }, fromName: "grace", date: 1767225000 },
    };
    yield { id: 8, date: 1767225700, className: "MessageService" };
    yield {
      id: 9,
      date: 1767225800,
      className: "Message",
      media: {
        className: "MessageMediaDocument",
        document: {
          id: "5001",
          mimeType: "application/pdf",
          size: 2048,
          attributes: [{ fileName: "agenda.pdf" }],
        },
      },
    };
    yield {
      id: 10,
      date: 1767225900,
      className: "Message",
      media: { className: "MessageMediaPoll" },
    };
    // A record with no id cannot be pointed back at; it is dropped.
    yield { date: 1767226000, className: "Message" };
  };

  expect(await drain(api().messages("-42", { min_id: 0, limit: 10 }))).toEqual([
    {
      peer_id: "-42",
      id: 7,
      date: 1767225600,
      text: "on my way",
      // `out` decides which subject is `from` and which is `to` for a private
      // message, so it is worth pinning on its own.
      out: true,
      from: { id: "1003", display: "linus", kind: "user" },
      post_author: "grace",
      reply_to: 4,
      forward_from: { id: "1002", name: "grace", date: 1767225000 },
      edit_date: 1767225660,
      grouped_id: "9001",
      service: false,
    },
    {
      peer_id: "-42",
      id: 8,
      date: 1767225700,
      text: "",
      out: false,
      service: true,
    },
    {
      peer_id: "-42",
      id: 9,
      date: 1767225800,
      text: "",
      out: false,
      service: false,
      attachment: {
        attachment_id: "5001",
        media_type: "application/pdf",
        filename: "agenda.pdf",
        byte_size: 2048,
      },
    },
    {
      peer_id: "-42",
      id: 10,
      date: 1767225900,
      text: "",
      out: false,
      service: false,
      media_kind: "MessageMediaPoll",
    },
  ] satisfies TelegramMessage[]);
});

test.skipIf(!OFFLINE)("the signed-in account arrives as a plain record", async () => {
  pages.me = {
    id: { toString: () => "1001" },
    username: "ada",
    firstName: "ada",
  };
  expect(await api().me()).toEqual({
    id: "1001",
    username: "ada",
    first_name: "ada",
    bot: false,
  } satisfies TelegramUser);

  pages.me = {
    id: { toString: () => "1004" },
    firstName: "acme",
    lastName: "helper",
    bot: true,
  };
  expect(await api().me()).toEqual({
    id: "1004",
    first_name: "acme",
    last_name: "helper",
    bot: true,
  } satisfies TelegramUser);
});

test.skipIf(!OFFLINE)("a history query is asked for in ascending order and within one page", async () => {
  pages.messages = async function* () {};
  // More than one page: the walk asks for what is left of its batch, and the
  // provider's own ceiling is what the request has to stay inside.
  await drain(api().messages("-42", { min_id: 7, max_id: 20, limit: 900 }));
  expect(pages.queries).toEqual([
    { reverse: true, offsetId: 7, minId: 7, maxId: 20, limit: 500, waitTime: 1 },
  ]);

  // An unbounded read is the same request with no upper id.
  await drain(api().messages("-42", { min_id: 0, limit: 120 }));
  expect(pages.queries[1]).toEqual({
    reverse: true,
    offsetId: 0,
    minId: 0,
    maxId: 0,
    limit: 120,
    waitTime: 1,
  });
});
