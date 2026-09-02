import { expect, mock, test } from "bun:test";
import { TelegramConnectorError } from "../src/api";
import type {
  SignInFlow,
  TelegramDialog,
  TelegramMessage,
  TelegramUser,
} from "../src/api";
import {
  FIXTURE_CREDENTIALS,
} from "../src/fixture";

/**
 * A stand-in for GramJS so the one file that talks to Telegram can be driven
 * cold, modelling only the shapes `client.ts` touches. The substitution is
 * process wide, so it is made only while the manual smoke test is off: with
 * `KIZUKI_TELEGRAM_SMOKE=1` that test needs the real library, whatever command
 * happens to load this file alongside it.
 */
const OFFLINE = process.env.KIZUKI_TELEGRAM_SMOKE !== "1";

class FloodWaitError extends Error {
  constructor(readonly seconds: number) {
    super(`A wait of ${seconds} seconds is required`);
  }
}

class RPCError extends Error {
  constructor(readonly errorMessage: string) {
    super(errorMessage);
  }
}

const pages: {
  dialogs: () => AsyncGenerator<unknown>;
  messages: () => AsyncGenerator<unknown>;
  invoke: (request: unknown) => Promise<unknown>;
  invoked: string[];
  /** The number the flow is signing in with has no account behind it. */
  signUpRequired: boolean;
  /** Raised from inside the library's sign-in loop, one per attempt. */
  signInErrors: unknown[];
  /** What the provider answers `getMe` with. */
  me: unknown;
} = {
  dialogs: async function* () {},
  messages: async function* () {},
  invoke: async () => ({}),
  invoked: [],
  signUpRequired: false,
  signInErrors: [],
  me: { id: { toString: () => "1001" } },
};

interface StartParams {
  phoneNumber: string;
  phoneCode: () => Promise<string>;
  password: (hint?: string) => Promise<string>;
  firstAndLastNames?: () => Promise<[string, string?]>;
  onError: (error: Error) => Promise<boolean>;
}

class FakeClient {
  /**
   * The library's own sign-in loops, transcribed from `client/auth.js`. Every
   * failure raised inside them — waits and transport faults included — is
   * handed to `onError`, and a `false` answer asks the owner again; nothing
   * escapes `start` on its own.
   */
  async start(params: StartParams): Promise<void> {
    for (;;) {
      try {
        if (pages.signUpRequired) {
          let firstName = "first name";
          if (params.firstAndLastNames !== undefined) {
            const names = await params.firstAndLastNames();
            firstName = names[0];
          }
          expect(firstName.length).toBeGreaterThan(0);
          pages.invoked.push("auth.SignUp");
          pages.invoked.push("help.AcceptTermsOfService");
          return;
        }
        await params.phoneCode();
        const failure = pages.signInErrors.shift();
        if (failure !== undefined) throw failure;
        return;
      } catch (error) {
        if (await params.onError(error as Error)) {
          throw new Error("AUTH_USER_CANCEL");
        }
      }
    }
  }

  async getMe(): Promise<unknown> {
    return pages.me;
  }

  iterDialogs(): AsyncGenerator<unknown> {
    return pages.dialogs();
  }

  iterMessages(): AsyncGenerator<unknown> {
    return pages.messages();
  }

  invoke(request: unknown): Promise<unknown> {
    pages.invoked.push((request as { name: string }).name);
    return pages.invoke(request);
  }
}

if (OFFLINE) {
  mock.module("telegram", () => ({
    TelegramClient: FakeClient,
    Logger: class {},
    Api: {
      auth: {
        LogOut: class {
          readonly name = "auth.LogOut";
        },
      },
      updates: {
        GetState: class {
          readonly name = "updates.GetState";
        },
      },
    },
    utils: {
      getPeerId: (peer: { id: string }) => peer.id,
      getDisplayName: (entity: { title?: string; firstName?: string }) =>
        entity.title ?? entity.firstName ?? "",
    },
  }));
  mock.module("telegram/sessions/index.js", () => ({
    StringSession: class {
      save(): string {
        return "";
      }
    },
  }));
  mock.module("telegram/extensions/Logger.js", () => ({
    LogLevel: { NONE: 0 },
  }));
  mock.module("telegram/errors/index.js", () => ({ FloodWaitError, RPCError }));
}

const { createRealApi } = await import("../src/client");

async function drain(source: AsyncIterable<unknown>): Promise<unknown> {
  const seen: unknown[] = [];
  try {
    for await (const item of source) seen.push(item);
  } catch (error) {
    return error;
  }
  return seen;
}

function api() {
  return createRealApi("session", FIXTURE_CREDENTIALS);
}

test.skipIf(!OFFLINE)("a wait reported while paging history reaches the caller normalised", async () => {
  pages.messages = async function* () {
    yield { id: 1, date: 100, message: "first", className: "Message" };
    throw new FloodWaitError(42);
  };
  const thrown = await drain(api().messages("1002", { min_id: 0, limit: 10 }));
  expect(thrown).toBeInstanceOf(TelegramConnectorError);
  expect((thrown as TelegramConnectorError).code).toBe("flood_wait");
  expect((thrown as TelegramConnectorError).retry_after).toBe(42);
});

test.skipIf(!OFFLINE)("a wait reported while paging dialogs reaches the caller normalised", async () => {
  pages.dialogs = async function* () {
    throw new FloodWaitError(17);
  };
  const thrown = await drain(api().dialogs(10));
  expect(thrown).toBeInstanceOf(TelegramConnectorError);
  expect((thrown as TelegramConnectorError).code).toBe("flood_wait");
});

test.skipIf(!OFFLINE)("a dead session reported while paging history says so", async () => {
  pages.messages = async function* () {
    throw new RPCError("AUTH_KEY_UNREGISTERED");
  };
  const thrown = await drain(api().messages("1002", { min_id: 0, limit: 10 }));
  expect((thrown as TelegramConnectorError).code).toBe("unauthenticated");
});

test.skipIf(!OFFLINE)("a socket fault while paging history is reported as unreachable", async () => {
  pages.messages = async function* () {
    throw new Error("read ECONNRESET");
  };
  const thrown = await drain(api().messages("1002", { min_id: 0, limit: 10 }));
  expect((thrown as TelegramConnectorError).code).toBe("unreachable");
});

async function thrown(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return null;
}

test.skipIf(!OFFLINE)("a live session answers the authorization probe", async () => {
  pages.invoked = [];
  pages.invoke = async () => ({});
  expect(await api().isAuthorized()).toBe(true);
  expect(pages.invoked).toEqual(["updates.GetState"]);
});

test.skipIf(!OFFLINE)("a session the provider has finished answers no", async () => {
  pages.invoke = async () => {
    throw new RPCError("SESSION_REVOKED");
  };
  expect(await api().isAuthorized()).toBe(false);
});

test.skipIf(!OFFLINE)(
  "a transport fault is not mistaken for a revoked session",
  async () => {
    pages.invoke = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const caught = await thrown(() => api().isAuthorized());
    expect(caught).toBeInstanceOf(TelegramConnectorError);
    // The provider never answered; reporting a revoked sign-in would send the
    // owner to authenticate again over a connection that is merely down.
    expect((caught as TelegramConnectorError).code).toBe("unreachable");
  },
);

test.skipIf(!OFFLINE)(
  "sign-in refuses to register the account the number has none of",
  async () => {
    const flow: SignInFlow = {
      phone: "+15551234567",
      code: async () => "22222",
      password: async () => "hunter",
      onError: async () => false,
    };
    pages.signUpRequired = true;
    pages.invoked = [];
    const caught = await thrown(() => api().start(flow));
    pages.signUpRequired = false;
    expect(caught).toBeInstanceOf(TelegramConnectorError);
    expect((caught as TelegramConnectorError).code).toBe("sign_in_aborted");
    // Registering an account under a placeholder name and accepting the
    // provider's terms on the owner's behalf are both outbound actions.
    expect(pages.invoked).toEqual([]);
  },
);

function signInFlow(seen: string[]): SignInFlow {
  return {
    phone: "+15551234567",
    code: async () => "22222",
    password: async () => "hunter",
    // The bound `runSignIn` keeps, so a forwarded error cannot loop for ever.
    onError: async (name) => {
      seen.push(name);
      return seen.length >= 3;
    },
  };
}

test.skipIf(!OFFLINE)(
  "a wait reported while the code is checked is honoured, not counted against the owner",
  async () => {
    const seen: string[] = [];
    pages.signInErrors = [new FloodWaitError(30)];
    const caught = await thrown(() => api().start(signInFlow(seen)));
    pages.signInErrors = [];

    expect(caught).toBeInstanceOf(TelegramConnectorError);
    expect((caught as TelegramConnectorError).code).toBe("flood_wait");
    expect((caught as TelegramConnectorError).retry_after).toBe(30);
    // The owner typed the right code. Spending one of their three attempts on
    // a pause is how a wait becomes an abandoned sign-in.
    expect(seen).toEqual([]);
  },
);

test.skipIf(!OFFLINE)(
  "a code telegram refused is the one thing the flow is asked about",
  async () => {
    const seen: string[] = [];
    pages.signInErrors = [new RPCError("PHONE_CODE_INVALID")];
    await api().start(signInFlow(seen));
    expect(seen).toEqual(["PHONE_CODE_INVALID"]);
  },
);

test.skipIf(!OFFLINE)(
  "a dead session raised during sign-in ends it with the reason",
  async () => {
    const seen: string[] = [];
    pages.signInErrors = [new RPCError("AUTH_KEY_UNREGISTERED")];
    const caught = await thrown(() => api().start(signInFlow(seen)));
    pages.signInErrors = [];

    expect((caught as TelegramConnectorError).code).toBe("unauthenticated");
    expect(seen).toEqual([]);
  },
);

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
