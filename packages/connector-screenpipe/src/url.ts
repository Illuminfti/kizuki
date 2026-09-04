const SECRET_SEGMENT = /^(?:[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+)$/;

export function redactBrowserUrl(
  browserUrl: string | null,
  retainFull: boolean,
): string | null {
  if (browserUrl === null || browserUrl.length === 0) return null;
  try {
    const parsed = new URL(browserUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (retainFull) {
      return parsed.toString();
    }
    const path = parsed.pathname
      .split("/")
      .map((segment) => (SECRET_SEGMENT.test(segment) ? "[redacted]" : segment))
      .join("/");
    return `${parsed.origin}${path === "" ? "/" : path}`;
  } catch {
    return null;
  }
}
