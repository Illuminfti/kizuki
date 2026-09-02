import type { SignInIo } from "@kizuki/core";
import { TelegramConnectorError } from "./api";
import type { SignInFlow, TelegramApi } from "./api";

/** Rejected codes or passwords tolerated before sign-in is abandoned. */
const MAX_ATTEMPTS = 3;
/** A wait longer than this is reported to the owner rather than slept through. */
const MAX_SILENT_WAIT_SECONDS = 60;

export const PHONE_FORMAT = /^\+[0-9]{6,15}$/;

/**
 * Provider text on its way to a terminal. Account names and password hints are
 * attacker-controlled, and one escape sequence in either can repaint the
 * screen or answer for the owner. Evidence keeps the original; the terminal
 * gets the printable part of it.
 */
export function terminalSafe(text: string): string {
  return text.replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

export function waitSeconds(error: unknown): number | null {
  return error instanceof TelegramConnectorError &&
    error.code === "flood_wait" &&
    error.retry_after !== undefined
    ? error.retry_after
    : null;
}

/**
 * Drives the provider's phone-code flow over the terminal capabilities the
 * host lends us. Nothing typed here is persisted or echoed: the number, the
 * code and the password stay inside this call.
 */
export async function runSignIn(
  api: TelegramApi,
  io: SignInIo,
  phone: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let failures = 0;
  let aborted = false;
  const flow: SignInFlow = {
    phone,
    code: () => io.prompt("Code Telegram sent you: "),
    password: (hint) =>
      io.prompt(
        hint === undefined
          ? "Two-step verification password: "
          : `Two-step verification password (hint: ${terminalSafe(hint)}): `,
        { secret: true },
      ),
    onError: async () => {
      failures += 1;
      io.notify("that code/password was not accepted, try again");
      aborted = failures >= MAX_ATTEMPTS;
      return aborted;
    },
  };
  let waited = false;
  for (;;) {
    try {
      await api.start(flow);
      return;
    } catch (error) {
      if (aborted) {
        throw new TelegramConnectorError(
          "sign_in_aborted",
          "kizuki.telegram: sign-in was abandoned after repeated rejected attempts",
          { cause: error },
        );
      }
      const seconds = waitSeconds(error);
      if (waited || seconds === null || seconds > MAX_SILENT_WAIT_SECONDS) {
        throw error;
      }
      waited = true;
      io.notify(`Telegram asked us to wait ${seconds}s`);
      await sleep(seconds * 1000);
    }
  }
}
