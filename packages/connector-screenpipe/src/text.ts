/**
 * Cuts to `limit` UTF-16 code units. Every caller counts units — the event
 * bound, the README and the truncation flag all do — while SQLite's `substr`
 * counts code points, so a column of astral characters arrives at up to twice
 * the length the cut in the query promised.
 *
 * A cut between the halves of a surrogate pair leaves a lone surrogate, which
 * SQLite and a file write both replace on the way back out; the stored text
 * would then no longer match the content hash taken from the event, so the pair
 * is dropped whole.
 */
export function cutText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
