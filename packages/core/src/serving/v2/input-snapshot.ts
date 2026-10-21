import { cloneExactJson, isPlainObject } from "../../util/validate";
import { ServeError } from "../types";

/** One descriptor-safe immutable snapshot. Neither validation nor a later
 * asynchronous retry can observe changed getters or caller-owned objects. */
export function snapshotScopedInput(value: unknown): Record<string, unknown> {
  const errors: string[] = [];
  const input = cloneExactJson(value, "args", { maxDepth: 12, maxKeysPerObject: 64, maxArrayLength: 256, maxStringBytes: 262144, maxKeyBytes: 128, maxTotalBytes: 524288 }, errors);
  if (errors.length !== 0 || !isPlainObject(input)) throw new ServeError("invalid_arguments", "invalid arguments: invalid scoped input");
  return input;
}
