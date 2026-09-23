import { TelegramConnectorError } from "./api";
import type { DataCenter } from "./api";

/**
 * Telegram's published test environment, for exercising a real sign-in
 * without a real account. Only a fresh sign-in reads this: a stored session
 * names its own data center, so enrollment is the one place it can apply.
 * Unset is the only default, and a value other than a listed id is refused
 * rather than ignored, so a typo never signs in somewhere unexpected.
 */
export const TEST_DC_VARIABLE = "KIZUKI_TELEGRAM_TEST_DC";

/** Addresses from Telegram's test configuration; port 80 is what the transport dials. */
const TEST_DATA_CENTERS: Readonly<Record<string, DataCenter>> = {
  "1": { id: 1, address: "149.154.175.10", port: 80 },
  "2": { id: 2, address: "149.154.167.40", port: 80 },
  "3": { id: 3, address: "149.154.175.117", port: 80 },
};

export function testDataCenter(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DataCenter | null {
  const raw = environment[TEST_DC_VARIABLE];
  if (raw === undefined || raw === "") return null;
  const selected = Object.hasOwn(TEST_DATA_CENTERS, raw)
    ? TEST_DATA_CENTERS[raw]
    : undefined;
  if (selected === undefined) {
    throw new TelegramConnectorError(
      "invalid_test_dc",
      `kizuki.telegram: ${TEST_DC_VARIABLE} must be 1, 2 or 3 when set`,
    );
  }
  return selected;
}
