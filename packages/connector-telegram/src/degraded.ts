import { MAX_DIALOGS } from "./cursor";
import type { DialogListing } from "./walk";

/**
 * What the account's own listing could not show, as one line for `health`.
 * `null` when it showed everything: a complete listing is not a caveat.
 *
 * A peer the listing has stopped naming is not one of these. Leaving a chat is
 * an ordinary act with no fault behind it, nothing the connector can do would
 * clear the report, and naming the peers would publish account identifiers
 * into a surface meant to say whether the connection works.
 */
export function degradedDetail(listing: DialogListing | null): string | null {
  if (listing === null || !listing.limitReached) return null;
  return `dialog limit reached (${MAX_DIALOGS}); newest dialogs only`;
}
