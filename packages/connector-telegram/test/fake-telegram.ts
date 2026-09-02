import { expect, mock } from "bun:test";
import { FIXTURE_CREDENTIALS } from "../src/fixture";
import type { TelegramApi } from "../src/api";

/**
 * A stand-in for GramJS so the one file that talks to Telegram can be driven
 * cold, modelling only the shapes `client.ts` touches. The substitution is
 * process wide, so it is made only while the manual smoke test is off: with
 * `KIZUKI_TELEGRAM_SMOKE=1` that test needs the real library, whatever command
 * happens to load this module alongside it.
 */
export const OFFLINE = process.env.KIZUKI_TELEGRAM_SMOKE !== "1";

export class FloodWaitError extends Error {
  constructor(readonly seconds: number) {
    super(`A wait of ${seconds} seconds is required`);
  }
}

export class RPCError extends Error {
  constructor(readonly errorMessage: string) {
    super(errorMessage);
  }
}

export const pages: {
  dialogs: () => AsyncGenerator<unknown>;
  messages: () => AsyncGenerator<unknown>;
  invoke: (request: unknown) => Promise<unknown>;
  invoked: string[];
  /** Every history query the library was handed, newest last. */
  queries: Record<string, unknown>[];
  /** The number the flow is signing in with has no account behind it. */
  signUpRequired: boolean;
  /** Raised from inside the library's sign-in loop, one per attempt. */
  signInErrors: unknown[];
  /** What the provider answers `getMe` with. */
  me: unknown;
  /** Raised by the transport rather than by a request, when set. */
  transport: { connect: unknown; disconnect: unknown };
} = {
  dialogs: async function* () {},
  messages: async function* () {},
  invoke: async () => ({}),
  invoked: [],
  queries: [],
  signUpRequired: false,
  signInErrors: [],
  me: { id: { toString: () => "1001" } },
  transport: { connect: null, disconnect: null },
};

/** Puts every armed answer back, so one test cannot set up the next one. */
export function reset(): void {
  pages.dialogs = async function* () {};
  pages.messages = async function* () {};
  pages.invoke = async () => ({});
  pages.invoked = [];
  pages.queries = [];
  pages.signUpRequired = false;
  pages.signInErrors = [];
  pages.me = { id: { toString: () => "1001" } };
  pages.transport = { connect: null, disconnect: null };
}

interface StartParams {
  phoneNumber: string;
  phoneCode: () => Promise<string>;
  password: (hint?: string) => Promise<string>;
  firstAndLastNames?: () => Promise<[string, string?]>;
  onError: (error: Error) => Promise<boolean>;
}

class FakeClient {
  async connect(): Promise<void> {
    if (pages.transport.connect !== null) throw pages.transport.connect;
    pages.invoked.push("connect");
  }

  async disconnect(): Promise<void> {
    if (pages.transport.disconnect !== null) throw pages.transport.disconnect;
    pages.invoked.push("disconnect");
  }

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

  iterMessages(
    _peer: unknown,
    query: Record<string, unknown>,
  ): AsyncGenerator<unknown> {
    pages.queries.push(query);
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
      constructor(readonly text: string = "") {}
      save(): string {
        return this.text;
      }
    },
  }));
  mock.module("telegram/extensions/Logger.js", () => ({
    LogLevel: { NONE: 0 },
  }));
  mock.module("telegram/errors/index.js", () => ({ FloodWaitError, RPCError }));
}

const { createRealApi } = await import("../src/client");

/** A client over the stand-in, holding a session recognisable in a saved one. */
export function api(session = "session"): TelegramApi {
  return createRealApi(session, FIXTURE_CREDENTIALS);
}

export async function drain(source: AsyncIterable<unknown>): Promise<unknown> {
  const seen: unknown[] = [];
  try {
    for await (const item of source) seen.push(item);
  } catch (error) {
    return error;
  }
  return seen;
}

export async function thrown(
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return null;
}
