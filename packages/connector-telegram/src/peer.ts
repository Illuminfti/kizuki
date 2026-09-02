/**
 * Whether a channel is reachable by a public handle, which is what turns its
 * messages into `public` evidence. Telegram marks each alias in `usernames`
 * with its own `active` flag, and an inactive alias resolves for nobody, so
 * anything short of a live handle fails closed to private.
 */
export function hasPublicHandle(entity: unknown): boolean {
  if (typeof entity !== "object" || entity === null) return false;
  const record = entity as { username?: unknown; usernames?: unknown };
  if (typeof record.username === "string" && record.username.length > 0) {
    return true;
  }
  if (!Array.isArray(record.usernames)) return false;
  return record.usernames.some((alias) => {
    if (typeof alias !== "object" || alias === null) return false;
    const named = alias as { username?: unknown; active?: unknown };
    return (
      named.active === true &&
      typeof named.username === "string" &&
      named.username.length > 0
    );
  });
}
