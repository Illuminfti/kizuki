import type { SecretResolver } from "@kizuki/core";
import { TelegramConnectorError, redactedCause } from "./api";
import type { AppCredentials, TelegramApi, TelegramApiFactory, TelegramUser } from "./api";
import { requireAppCredentials } from "./app-credentials";
import { notSignedIn } from "./refusals";
import { parseState } from "./state";

/** What opening a session needs: a client to build and the credentials for it. */
export interface SessionDeps {
  api: TelegramApiFactory;
  credentials: () => AppCredentials | null;
}

/** The teardown a failure path takes: the original fault is the useful one. */
export async function disconnectQuietly(api: TelegramApi): Promise<void> {
  try {
    await api.disconnect();
  } catch {
    return;
  }
}

/**
 * Turns a stored state reference into a client that has proved which account
 * it is. Nothing here can start a login: a session that is finished, or one
 * belonging to someone else, is refused rather than replaced.
 */
export async function openSession(
  deps: SessionDeps,
  ref: string,
  resolve: SecretResolver,
): Promise<{ api: TelegramApi; self: TelegramUser }> {
  let text: string;
  try {
    text = await resolve(ref);
  } catch (error) {
    // The resolver failed over the state file, so its own report may name the
    // bytes it was reading. Only the shape of that failure is safe to carry.
    throw new TelegramConnectorError(
      "missing_session",
      notSignedIn().message,
      { cause: redactedCause(error) },
    );
  }
  const state = parseState(text);
  const credentials = requireAppCredentials(deps.credentials);
  const api = deps.api(state.session, credentials);
  try {
    await api.connect();
    if (!(await api.isAuthorized())) {
      throw new TelegramConnectorError(
        "unauthenticated",
        "kizuki.telegram: the stored session is no longer authorized; sign in again",
      );
    }
    const self = await api.me();
    if (self.id !== state.user_id) {
      throw new TelegramConnectorError(
        "identity_mismatch",
        "kizuki.telegram: signed-in account does not match the stored connection",
      );
    }
    return { api, self };
  } catch (error) {
    await disconnectQuietly(api);
    throw error;
  }
}
