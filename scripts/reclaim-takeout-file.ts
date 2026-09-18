import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { distillTakeoutActivity } from "./reclaim-takeout-spike";

// Keep file allocation bounded before the projector sees any input.
const MAX_BYTES = 1_048_576;

/** Local post-1.0 experiment: read one explicitly selected extracted file.
 * No archive traversal, model calls, network, persistence, or CLI registration.
 * Parent directories are caller-trusted; only the final symlink is refused.
 */
export function distillTakeoutActivityFile(path: string): ReturnType<typeof distillTakeoutActivity> {
  let fd: number | undefined;
  let input: Buffer;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a regular file");
    // Read at most the limit plus one sentinel byte, even if the file grows
    // after stat. Never use readFile on a potentially multi-GB export.
    input = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < input.length) {
      const count = readSync(fd, input, length, input.length - length, null);
      if (count === 0) break;
      length += count;
    }
    input = input.subarray(0, length);
  } catch {
    // Filesystem diagnostics contain private paths. Do not propagate them.
    throw new Error("Takeout activity file must be a readable regular file");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (input.length > MAX_BYTES) throw new Error("Takeout activity exceeds byte limit");
  const text = input.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(input)) {
    throw new Error("Takeout activity must be lossless UTF-8");
  }
  return distillTakeoutActivity(text);
}
