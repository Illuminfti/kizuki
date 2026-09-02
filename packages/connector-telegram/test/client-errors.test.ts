import { beforeEach, expect, test } from "bun:test";
import { TelegramConnectorError } from "../src/api";
import type { SignInFlow } from "../src/api";
import {
  FloodWaitError,
  OFFLINE,
  RPCError,
  api,
  drain,
  pages,
  reset,
  thrown,
} from "./fake-telegram";

beforeEach(reset);

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

test.skipIf(!OFFLINE)("a teardown the library faults on stays in this vocabulary", async () => {
  pages.transport.disconnect = new TypeError("cannot read properties of undefined");
  const live = api();
  await live.connect();
  const caught = await thrown(() => live.disconnect());
  pages.transport.disconnect = null;
  // A caller that only handles this package's errors would otherwise meet a
  // raw library fault on the one path it takes while cleaning up.
  expect(caught).toBeInstanceOf(TelegramConnectorError);
  expect((caught as TelegramConnectorError).code).toBe("unreachable");
});

test.skipIf(!OFFLINE)("a transport fault while connecting is reported as unreachable", async () => {
  pages.transport.connect = new Error("connect ETIMEDOUT");
  const caught = await thrown(() => api().connect());
  expect(caught).toBeInstanceOf(TelegramConnectorError);
  expect((caught as TelegramConnectorError).code).toBe("unreachable");
});

test.skipIf(!OFFLINE)("closing a client that was never started asks nothing of the library", async () => {
  // Armed so that reaching the library at all would be visible as a throw.
  pages.transport.disconnect = new Error("nothing was ever opened");
  await api().disconnect();
  expect(pages.invoked).toEqual([]);
});

test.skipIf(!OFFLINE)("signing out asks the provider to end the session", async () => {
  await api().logOut();
  // Revocation is a request Telegram has to receive; a local close is not one.
  expect(pages.invoked).toEqual(["auth.LogOut"]);
});

test.skipIf(!OFFLINE)("the session a client saves is the one it is running", async () => {
  const live = api("saved-session");
  let refused: unknown;
  try {
    live.saveSession();
  } catch (error) {
    refused = error;
  }
  // Nothing is running yet, so there is no session to write into state.
  expect((refused as TelegramConnectorError).code).toBe("missing_session");

  await live.connect();
  expect(live.saveSession()).toBe("saved-session");
});
