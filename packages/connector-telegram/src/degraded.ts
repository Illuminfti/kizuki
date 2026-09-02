import { MAX_DIALOGS } from "./cursor";
import type { DialogListing } from "./walk";

/** Peer ids named in health so a truncated view is actionable, not just visible. */
const NAMED_DIALOGS = 5;

/**
 * What is missing from the account's dialogs, as one line for `health`. `null`
 * when nothing is: a listing that showed everything is not a caveat.
 */
export function degradedDetail(listing: DialogListing | null): string | null {
  if (listing === null) return null;
  const parts: string[] = [];
  if (listing.limitReached) {
    parts.push(`dialog limit reached (${MAX_DIALOGS}); newest dialogs only`);
  }
  const missing = listing.unreadable;
  if (missing.length > 0) {
    const named = missing.slice(0, NAMED_DIALOGS).join(", ");
    const rest =
      missing.length > NAMED_DIALOGS
        ? `, and ${missing.length - NAMED_DIALOGS} more`
        : "";
    parts.push(
      `dialogs the account no longer lists (${missing.length}): ${named}${rest}`,
    );
  }
  return parts.length === 0 ? null : parts.join("; ");
}
