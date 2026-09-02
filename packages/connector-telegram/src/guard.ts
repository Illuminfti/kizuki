import { TelegramConnectorError } from "./api";

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
 * The two provider predicates the classifier needs. Keeping them behind an
 * interface is what lets the failure paths be exercised without loading the
 * library, which is otherwise reachable only from the manual smoke test.
 */
export interface ProviderErrors {
  isFloodWait(error: unknown): error is { seconds: number };
  isRpcError(error: unknown): error is { errorMessage: string };
}

export function classify(
  error: unknown,
  errors: ProviderErrors,
): TelegramConnectorError {
  if (error instanceof TelegramConnectorError) return error;
  if (errors.isFloodWait(error)) {
    return new TelegramConnectorError(
      "flood_wait",
      `kizuki.telegram: telegram asked us to wait ${error.seconds}s`,
      { retry_after: error.seconds, cause: error },
    );
  }
  if (!errors.isRpcError(error)) {
    // Socket, timeout and name-resolution faults never reach the RPC layer.
    return new TelegramConnectorError(
      "unreachable",
      "kizuki.telegram: telegram is unreachable",
      { cause: error },
    );
  }
  const name = error.errorMessage;
  if (DEAD_SESSION.has(name)) {
    return new TelegramConnectorError(
      "unauthenticated",
      "kizuki.telegram: the stored session is no longer authorized; sign in again",
      { cause: error },
    );
  }
  if (name === "PHONE_NUMBER_INVALID") {
    return new TelegramConnectorError(
      "invalid_phone",
      "kizuki.telegram: telegram rejected the phone number",
      { cause: error },
    );
  }
  return new TelegramConnectorError(
    "parse_error",
    `kizuki.telegram: telegram returned ${name}`,
    { cause: error },
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
