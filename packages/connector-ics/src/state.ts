import { KizukiError, isPlainObject } from "@kizuki/core";

export const ICS_STATE_SCHEMA = "kizuki.ics-state/v1" as const;

/**
 * A private calendar URL embeds a capability token, so it is a credential:
 * it lives in the host's opaque state file and never in SQLite, an error, a
 * log line or event metadata.
 */
export interface IcsState {
  schema: typeof ICS_STATE_SCHEMA;
  url: string;
}

function refuse(requirement: string): never {
  throw new KizukiError("misconfigured", `kizuki.ics: connection state ${requirement}`);
}

export function normalizeCalendarUrl(raw: string): string {
  const trimmed = raw.trim();
  const rewritten = /^webcal:\/\//i.test(trimmed)
    ? `https://${trimmed.slice("webcal://".length)}`
    : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(rewritten);
  } catch {
    throw new KizukiError(
      "misconfigured",
      "kizuki.ics: only https:// calendar URLs are supported",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new KizukiError(
      "misconfigured",
      "kizuki.ics: only https:// calendar URLs are supported",
    );
  }
  return parsed.toString();
}

export function parseIcsState(text: string): IcsState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new KizukiError(
      "misconfigured",
      "kizuki.ics: connection state is not readable",
      { cause: error },
    );
  }
  if (!isPlainObject(parsed)) refuse("must be an object");
  for (const key of Object.keys(parsed)) {
    if (key !== "schema" && key !== "url") refuse("has an unknown field");
  }
  if (parsed["schema"] !== ICS_STATE_SCHEMA) refuse(`schema must be ${ICS_STATE_SCHEMA}`);
  const url = parsed["url"];
  if (typeof url !== "string" || url.length === 0) {
    refuse("field url must be a non-empty string");
  }
  if (!url.startsWith("https://")) refuse("field url must be an https URL");
  return { schema: ICS_STATE_SCHEMA, url };
}

export function serializeIcsState(state: IcsState): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ schema: state.schema, url: state.url }),
  );
}
