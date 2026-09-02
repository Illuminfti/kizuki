import { TelegramConnectorError, redactedCause } from "./api";

/** Provider errors that mean the stored session is finished, not merely failing. */
const DEAD_SESSION = new Set([
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
]);

/**
 * Provider errors that mean the owner typed something Telegram would not take.
 * They are the only sign-in failures worth another prompt; every other one,
 * a wait or a transport fault included, ends the flow with its own reason.
 */
const REFUSED_CREDENTIAL = new Set([
  "PHONE_CODE_INVALID",
  "PHONE_CODE_EMPTY",
  "PHONE_CODE_EXPIRED",
  "PHONE_CODE_HASH_EMPTY",
  "PASSWORD_HASH_INVALID",
]);

export function isRefusedCredential(name: string): boolean {
  return REFUSED_CREDENTIAL.has(name);
}

/**
 * The two provider predicates the classifier needs. Keeping them behind an
 * interface is what lets the failure paths be exercised without loading the
 * library, which is otherwise reachable only from the manual smoke test.
 */
export interface ProviderErrors {
  isFloodWait(error: unknown): error is { seconds: number };
  isRpcError(error: unknown): error is { errorMessage: string };
}

/** A length the connector can actually wait out, or nothing to act on. */
function waitLength(seconds: unknown): number | null {
  return Number.isSafeInteger(seconds) && (seconds as number) >= 0
    ? (seconds as number)
    : null;
}

/**
 * Every field of a provider failure is text the provider chose, and this
 * connector holds a credential that would be worth writing into one. So no
 * part of such a failure is repeated or retained: a name is echoed only when
 * it is spelled like one of the provider's own, a wait only when its length
 * is a number, and the failure itself never becomes a cause a renderer would
 * walk into.
 */
export function classify(
  error: unknown,
  errors: ProviderErrors,
): TelegramConnectorError {
  if (error instanceof TelegramConnectorError) return error;
  const cause = redactedCause(error);
  if (errors.isFloodWait(error)) {
    const seconds = waitLength(error.seconds);
    return seconds === null
      ? new TelegramConnectorError(
          "flood_wait",
          "kizuki.telegram: telegram asked us to wait, without saying how long",
          { cause },
        )
      : new TelegramConnectorError(
          "flood_wait",
          `kizuki.telegram: telegram asked us to wait ${seconds}s`,
          { retry_after: seconds, cause },
        );
  }
  if (!errors.isRpcError(error)) {
    // Socket, timeout and name-resolution faults never reach the RPC layer.
    return new TelegramConnectorError(
      "unreachable",
      "kizuki.telegram: telegram is unreachable",
      { cause },
    );
  }
  const raw = error.errorMessage;
  if (DEAD_SESSION.has(raw)) {
    return new TelegramConnectorError(
      "unauthenticated",
      "kizuki.telegram: the stored session is no longer authorized; sign in again",
      { cause },
    );
  }
  if (raw === "PHONE_NUMBER_INVALID") {
    return new TelegramConnectorError(
      "invalid_phone",
      "kizuki.telegram: telegram rejected the phone number",
      { cause },
    );
  }
  // A name this connector never taught itself to read is provider text like
  // any other, and repeating it is how a credential written into a reply frame
  // would reach a log. The code is what a caller acts on either way.
  return new TelegramConnectorError(
    "parse_error",
    "kizuki.telegram: telegram refused the request",
    { cause },
  );
}

/**
 * Paging is where waits are actually reported, and a lazy provider iterator
 * raises them while it is being advanced rather than when it is created. Both
 * moments, and the per-record mapping in between, are classified here so a
 * caller only ever sees this package's error vocabulary.
 */
export async function* guarded<T, U>(
  open: () => AsyncIterable<T>,
  map: (item: T) => U | null,
  errors: ProviderErrors,
): AsyncGenerator<U> {
  try {
    for await (const item of open()) {
      const mapped = map(item);
      if (mapped !== null) yield mapped;
    }
  } catch (error) {
    throw classify(error, errors);
  }
}
