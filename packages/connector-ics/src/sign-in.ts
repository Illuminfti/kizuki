import { KizukiError } from "@kizuki/core";
import type {
  ConnectionStateWriter,
  SignInDisplay,
  SignInIo,
} from "@kizuki/core";
import type { IcsFetcher } from "./fetch";
import { parseIcs } from "./parse";
import { normalizeCalendarUrl, serializeIcsState } from "./state";

export const MAX_DISPLAY_CHARS = 80;

function label(text: string): string {
  return Array.from(text)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, MAX_DISPLAY_CHARS);
}

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
    display: label(
      name !== null && name.length > 0 ? name : new URL(url).hostname,
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
