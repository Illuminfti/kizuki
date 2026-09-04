/**
 * LifeOS auto-wiki / RFC 0002 E11: unavailable is not empty.
 * Only empty or a successful mine advances the extract cursor.
 */
export type ExtractMine =
  | { status: "ok"; count: number }
  | { status: "empty" }
  | { status: "unavailable"; reason: string }
  | { status: "rejected"; reason: string };

export function shouldAdvanceExtractCursor(result: ExtractMine): boolean {
  switch (result.status) {
    case "ok":
    case "empty":
      return true;
    case "unavailable":
    case "rejected":
      return false;
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
