import type {
  ConnectionStateWriter,
  SignInDisplay,
  SignInIo,
} from "@kizuki/core";
import type { IcsFetcher } from "./fetch";
import { sanitize } from "./map";
import { parseIcs } from "./parse";
import { normalizeCalendarUrl, serializeIcsState } from "./state";

export const MAX_DISPLAY_CHARS = 80;

/**
 * URL mode. The owner types one address; it is verified by fetching and
 * parsing it once, then handed to the host as opaque bytes — a private
 * calendar URL carries its own capability token and is treated as a secret.
 */
export async function signInIcs(
  io: SignInIo,
  writer: ConnectionStateWriter,
  fetcher: IcsFetcher,
): Promise<SignInDisplay> {
  const answer = await io.prompt("Calendar URL (https:// or webcal://): ");
  const url = normalizeCalendarUrl(answer);
  const response = await fetcher(url, {});
  const parsed = parseIcs(response.text);
  await writer.write(serializeIcsState({ schema: "kizuki.ics-state/v1", url }));
  const name = parsed.calendar.name;
  return {
    display: sanitize(
      name !== null && name.length > 0 ? name : new URL(url).hostname,
      MAX_DISPLAY_CHARS,
    ),
  };
}

export function urlLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "calendar";
  }
}
