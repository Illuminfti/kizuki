/**
 * Orders two strings by code point. `localeCompare` is locale-dependent, so a
 * vault walked on one machine and rebuilt on another would disagree about
 * which file is "first seen" and about derived row order.
 */
export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
