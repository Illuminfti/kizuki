import { expect, mock, test } from "bun:test";
import { TelegramConnectorError } from "../src/api";
import type { SignInFlow } from "../src/api";
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
} = {
  dialogs: async function* () {},
  messages: async function* () {},
  invoke: async () => ({}),
  invoked: [],
  signUpRequired: false,
};

interface StartParams {
  phoneNumber: string;
  phoneCode: () => Promise<string>;
  password: (hint?: string) => Promise<string>;
  firstAndLastNames?: () => Promise<[string, string?]>;
  onError: (error: Error) => Promise<boolean>;
}

class FakeClient {
  /** The library's own sign-up branch, transcribed from `client/auth.js`. */
  async start(params: StartParams): Promise<void> {
    if (!pages.signUpRequired) return;
    for (;;) {
      try {
        let firstName = "first name";
        if (params.firstAndLastNames !== undefined) {
          const names = await params.firstAndLastNames();
          firstName = names[0];
        }
        expect(firstName.length).toBeGreaterThan(0);
        pages.invoked.push("auth.SignUp");
        pages.invoked.push("help.AcceptTermsOfService");
        return;
      } catch (error) {
        if (await params.onError(error as Error)) {
          throw new Error("AUTH_USER_CANCEL");
        }
      }
    }
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
      getDisplayName: () => "grace",
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

test.skipIf(!OFFLINE)("a channel with only inactive aliases is not treated as public", async () => {
  pages.dialogs = async function* () {
    yield {
      entity: { id: "-100777", usernames: [{ username: "acme", active: false }] },
      isUser: false,
      isGroup: false,
      message: { id: 4 },
    };
    yield {
      entity: { id: "-100888", usernames: [{ username: "acme2", active: true }] },
      isUser: false,
      isGroup: false,
      message: { id: 9 },
    };
  };
  const listed = (await drain(api().dialogs(10))) as { public: boolean }[];
  expect(listed.map((dialog) => dialog.public)).toEqual([false, true]);
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
