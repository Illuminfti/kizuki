import type {
  AppCredentials,
  TelegramDialog,
  TelegramMessage,
  TelegramUser,
} from "./api";

/**
 * The synthetic account every test and the offline `fixture()` run against.
 * Nothing here corresponds to a real person, chat or credential.
 */

/** Recognisable, obviously synthetic, and asserted against by the redaction tests. */
export const FIXTURE_SESSION = "fixture-session-token-not-a-real-credential";
export const FIXTURE_CREDENTIALS: AppCredentials = {
  api_id: 12345,
  api_hash: "cafe",
};
export const FIXTURE_OBSERVED_AT = "2026-01-01T00:00:00.000Z";

export interface ScriptedSignIn {
  code: string;
  password?: string;
  password_hint?: string;
  /** How many times `start` reports a wait before it accepts the flow. */
  flood?: { seconds: number; times: number };
}

export interface ScriptedAccount {
  me: TelegramUser;
  authorized: boolean;
  dialogs: TelegramDialog[];
  /** Per peer id, ascending message ids. */
  messages: Record<string, TelegramMessage[]>;
  /** The call after this many `messages()` calls reports a wait, once. */
  flood?: { after_calls: number; seconds: number };
  sign_in?: ScriptedSignIn;
}

function at(day: number, hour: number, minute: number): number {
  return Math.floor(Date.UTC(2026, 0, day, hour, minute, 0) / 1000);
}

const ADA: TelegramUser = {
  id: "1001",
  username: "ada",
  first_name: "ada",
  bot: false,
};

const PRIVATE_MESSAGES: TelegramMessage[] = [
  { peer_id: "1002", id: 1, date: at(2, 9, 0), text: "morning", out: false, service: false },
  { peer_id: "1002", id: 2, date: at(2, 9, 5), text: "morning back", out: true, service: false },
  {
    peer_id: "1002",
    id: 3,
    date: at(2, 9, 10),
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
  { peer_id: "1002", id: 4, date: at(2, 9, 15), text: "got it", out: true, service: false, reply_to: 3 },
  { peer_id: "1002", id: 5, date: at(2, 9, 20), text: "see you at the standup", out: false, service: false },
];

const GROUP_MESSAGES: TelegramMessage[] = [
  {
    peer_id: "-42",
    id: 10,
    date: at(3, 10, 0),
    text: "standup at ten",
    out: false,
    service: false,
    from: { id: "1002", display: "grace", kind: "user" },
  },
  {
    peer_id: "-42",
    id: 11,
    date: at(3, 10, 2),
    text: "on my way",
    out: false,
    service: false,
    from: { id: "1003", display: "linus", kind: "user" },
    edit_date: at(3, 10, 4),
  },
  {
    peer_id: "-42",
    id: 12,
    date: at(3, 10, 5),
    text: "",
    out: false,
    service: true,
    from: { id: "1003", display: "linus", kind: "user" },
  },
  {
    peer_id: "-42",
    id: 13,
    date: at(3, 10, 8),
    text: "sharing the agenda here too",
    out: true,
    service: false,
    from: { id: "1001", display: "@ada", kind: "user" },
    forward_from: { id: "1002", name: "grace", date: at(2, 9, 10) },
  },
];

const CHANNEL_MESSAGES: TelegramMessage[] = [
  {
    peer_id: "-100777",
    id: 20,
    date: at(4, 12, 0),
    text: "acme ships the first release",
    out: false,
    service: false,
    post_author: "grace",
  },
  {
    peer_id: "-100777",
    id: 21,
    date: at(4, 12, 30),
    text: "release notes are attached",
    out: false,
    service: false,
    attachment: { attachment_id: "7001", media_type: "image/jpeg" },
  },
  {
    peer_id: "-100777",
    id: 22,
    date: at(4, 13, 0),
    text: "",
    out: false,
    service: false,
    media_kind: "MessageMediaPoll",
  },
  {
    peer_id: "-100777",
    id: 23,
    date: at(4, 13, 30),
    text: "thanks for reading",
    out: false,
    service: false,
    from: { id: "1002", display: "grace", kind: "user" },
  },
];

/**
 * Frozen because it is exported, and because the scripted client that edits an
 * account it is handed is exported beside it. A caller reaching for either
 * must not be able to move the sample the conformance suite measures this
 * connector against; an attempt to fails loudly rather than quietly.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

export const FIXTURE_ACCOUNT: ScriptedAccount = deepFreeze({
  me: ADA,
  authorized: true,
  dialogs: [
    { peer_id: "1002", peer_type: "user", title: "grace", public: false, top_message_id: 5 },
    { peer_id: "-42", peer_type: "group", title: "acme planning", public: false, top_message_id: 13 },
    { peer_id: "-100777", peer_type: "channel", title: "acme news", public: true, top_message_id: 23 },
  ],
  messages: {
    "1002": PRIVATE_MESSAGES,
    "-42": GROUP_MESSAGES,
    "-100777": CHANNEL_MESSAGES,
  },
  sign_in: { code: "22222" },
});

/** Deep copy so a mutating caller cannot leak into the next one. */
export function fixtureAccount(
  overrides: Partial<ScriptedAccount> = {},
): ScriptedAccount {
  return {
    ...(structuredClone(FIXTURE_ACCOUNT) as ScriptedAccount),
    ...overrides,
  };
}
