import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ExtractReplayError, parseEmptySegmentReplayPlan, parseEmptySegmentReplaySupersessionPlan, sha256Hex, type ExtractReplayPlan } from "@kizuki/core";
import { SourceBackfillError, parseSourceBackfillPlan, type SourceBackfillPlan } from "@kizuki/core";

/** One private, bounded descriptor; hash and parse the identical bytes. */
function readOwnerPlan(path: string, expectedSha256: string): unknown {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 16_384n ||
        before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & 0o777n) !== 0o600n) throw new Error();
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error();
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (["dev", "ino", "size", "mode", "nlink", "uid", "mtimeNs", "ctimeNs"].some(key =>
      before[key as keyof typeof before] !== after[key as keyof typeof after]) || sha256Hex(bytes) !== expectedSha256) throw new Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new Error("invalid owner-local plan"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readEmptyReplayPlan(path: string, expectedSha256: string): ExtractReplayPlan {
  try {
    const value = readOwnerPlan(path, expectedSha256) as { schema?: unknown } | null;
    return value?.schema === "kizuki.extract-empty-replay/v2" ? parseEmptySegmentReplaySupersessionPlan(value) : parseEmptySegmentReplayPlan(value);
  } catch { throw new ExtractReplayError("invalid_plan"); }
}

export function readSourceBackfillPlan(path: string, expectedSha256: string): SourceBackfillPlan {
  try { return parseSourceBackfillPlan(readOwnerPlan(path, expectedSha256)); }
  catch { throw new SourceBackfillError("invalid_plan"); }
}
