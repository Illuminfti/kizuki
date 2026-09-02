import type { SignInIo } from "@kizuki/core";
import { TelegramConnectorError, safeCause } from "./api";
import type { SignInFlow, TelegramApi } from "./api";

/** Rejected codes or passwords tolerated before sign-in is abandoned. */
const MAX_ATTEMPTS = 3;
/** Answers that never reached Telegram, on their own budget. */
const MAX_BLANK_ANSWERS = 3;
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
  let blanks = 0;
  let aborted = false;
  let abandoned: TelegramConnectorError | null = null;
  const reject = (notice: string): boolean => {
    failures += 1;
    io.notify(notice);
    aborted = failures >= MAX_ATTEMPTS;
    return aborted;
  };
  /**
   * Nothing typed never reaches the provider. An empty answer is not a
   * credential Telegram refused, so it neither spends one of the tries that
   * are and is not sent in place of one; the owner is asked again until it is
   * plain that no answer is coming.
   */
  const ask = async (
    question: string,
    opts?: { secret?: boolean },
  ): Promise<string> => {
    for (;;) {
      const value = await io.prompt(question, opts);
      if (value.trim().length > 0) return value;
      blanks += 1;
      io.notify("nothing was entered, try again");
      if (blanks >= MAX_BLANK_ANSWERS) {
        abandoned = new TelegramConnectorError(
          "sign_in_aborted",
          "kizuki.telegram: sign-in was abandoned; nothing was entered",
        );
        throw abandoned;
      }
    }
  };
  const flow: SignInFlow = {
    // Telegram sends digits, and a terminal is a place where a pasted one
    // arrives with a space on it; the password is passed on as typed, because
    // an owner may have chosen to pad it.
    code: async () => (await ask("Code Telegram sent you: ")).trim(),
    phone,
    password: (hint) =>
      ask(
        hint === undefined
          ? "Two-step verification password: "
          : `Two-step verification password (hint: ${terminalSafe(hint)}): `,
        { secret: true },
      ),
    onError: async (name) => reject(rejectionNotice(name)),
  };
  let waited = false;
  for (;;) {
    try {
      await api.start(flow);
      return;
    } catch (error) {
      // The owner entered nothing, repeatedly. Whatever the library made of
      // that on the way out, the reason it stopped is the one to report.
      if (abandoned !== null) throw abandoned;
      if (aborted) {
        throw new TelegramConnectorError(
          "sign_in_aborted",
          "kizuki.telegram: sign-in was abandoned after repeated rejected attempts",
          { cause: safeCause(error) },
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

/**
 * Telegram names which credential it refused, and saying which one to type
 * again is the whole use of that name. The vocabulary is a fixed set, so no
 * provider text reaches the terminal through this.
 */
function rejectionNotice(name: string): string {
  return name.startsWith("PASSWORD")
    ? "that password was not accepted, try again"
    : "that code was not accepted, try again";
}
