import { expect, mock, test } from "bun:test";
import { TelegramConnectorError } from "../src/api";
import { FIXTURE_CREDENTIALS } from "../src/scripted";

/**
 * The library stands in for GramJS so the one file that talks to Telegram can
 * be driven cold. Only the shapes `client.ts` actually touches are modelled.
 */
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
} = {
  dialogs: async function* () {},
  messages: async function* () {},
};

class FakeClient {
  iterDialogs(): AsyncGenerator<unknown> {
    return pages.dialogs();
  }

  iterMessages(): AsyncGenerator<unknown> {
    return pages.messages();
  }
}

mock.module("telegram", () => ({
  TelegramClient: FakeClient,
  Logger: class {},
  Api: { auth: { LogOut: class {} } },
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

test("a wait reported while paging history reaches the caller normalised", async () => {
  pages.messages = async function* () {
    yield { id: 1, date: 100, message: "first", className: "Message" };
    throw new FloodWaitError(42);
  };
  const thrown = await drain(api().messages("1002", { min_id: 0, limit: 10 }));
  expect(thrown).toBeInstanceOf(TelegramConnectorError);
  expect((thrown as TelegramConnectorError).code).toBe("flood_wait");
  expect((thrown as TelegramConnectorError).retry_after).toBe(42);
});

test("a wait reported while paging dialogs reaches the caller normalised", async () => {
  pages.dialogs = async function* () {
    throw new FloodWaitError(17);
  };
  const thrown = await drain(api().dialogs(10));
  expect(thrown).toBeInstanceOf(TelegramConnectorError);
  expect((thrown as TelegramConnectorError).code).toBe("flood_wait");
});

test("a dead session reported while paging history says so", async () => {
  pages.messages = async function* () {
    throw new RPCError("AUTH_KEY_UNREGISTERED");
  };
  const thrown = await drain(api().messages("1002", { min_id: 0, limit: 10 }));
  expect((thrown as TelegramConnectorError).code).toBe("unauthenticated");
});

test("a socket fault while paging history is reported as unreachable", async () => {
  pages.messages = async function* () {
    throw new Error("read ECONNRESET");
  };
  const thrown = await drain(api().messages("1002", { min_id: 0, limit: 10 }));
  expect((thrown as TelegramConnectorError).code).toBe("unreachable");
});
