/**
 * The `?` list for an `IN (...)` clause. Every caller that binds a list of
 * ids needs it, and three copies of one line is three places to get the
 * count wrong.
 */
export function placeholders(count: number): string {
  return new Array<string>(count).fill("?").join(", ");
}
