import type {
  ConnectionStateWriter,
  Connector,
  SignInContext,
  SignInDisplay,
  SignInIo,
} from "../contracts/connector";
import { CONNECTOR_SIGN_IN_DEADLINE_MS } from "../contracts/connector";
import { withDeadline } from "../util/deadline";
import { LedgerError } from "./connections";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function assertConnectorBrowserUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LedgerError("connector browser URL is not a valid URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new LedgerError("connector browser URL must not include credentials");
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname)) {
    return parsed;
  }
  throw new LedgerError("connector browser URL must be https or loopback http");
}

/** The one host wrapper for openUrl: scheme and enrollment context, nothing else. */
export function guardedSignInIo(io: SignInIo): SignInIo {
  return {
    prompt: (question, opts) => io.prompt(question, opts),
    notify: (text) => io.notify(text),
    openUrl: async (url) => {
      const parsed = assertConnectorBrowserUrl(url);
      io.notify(`Opening ${parsed.origin}${parsed.pathname}`);
      await io.openUrl(parsed.toString());
    },
  };
}

/** The one host path for interactive sign-in: URL guard plus a deadline. */
export function runGuardedSignIn(
  connector: Connector,
  io: SignInIo,
  writer: ConnectionStateWriter,
  context: SignInContext,
): Promise<SignInDisplay> {
  const signIn = connector.signIn;
  if (typeof signIn !== "function") {
    throw new LedgerError("connector does not implement interactive sign-in");
  }
  return withDeadline(
    signIn.call(connector, guardedSignInIo(io), writer, context.mode === "replace"
      ? { mode: "replace", previous_state: context.previous_state.slice() }
      : { mode: "new" }),
    CONNECTOR_SIGN_IN_DEADLINE_MS,
    "sign-in timed out",
  );
}
