/**
 * Code-unit ordering, which is what every stable sort in the tree wants:
 * `localeCompare` reorders with the host locale and would make a sorted
 * result depend on the machine that produced it.
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
