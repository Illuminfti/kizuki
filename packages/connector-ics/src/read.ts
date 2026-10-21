import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { KizukiError } from "@kizuki/core";
import { MAX_ICS_CHARS } from "./unfold";

/** Bind admission and bounded UTF-8 decoding to one regular-file descriptor. */
export async function readCalendarFile(path: string): Promise<string> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (cause) { throw new KizukiError("misconfigured", "kizuki.ics: calendar file cannot be read", { cause }); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size)) throw new KizukiError("misconfigured", "kizuki.ics: calendar file cannot be read");
    if (info.size > MAX_ICS_CHARS) throw new KizukiError("parse_error", "kizuki.ics: calendar text is too long");
    // One extra byte proves growth; a size change refuses instead of
    // allocating from the new size or accepting a truncated calendar.
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const next = await handle.read(bytes, size, bytes.length - size, size);
      if (next.bytesRead === 0) break;
      size += next.bytesRead;
    }
    if (size !== info.size) throw new KizukiError("parse_error", "kizuki.ics: calendar file changed while reading");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)); }
    catch (cause) { throw new KizukiError("parse_error", "kizuki.ics: calendar file must be UTF-8", { cause }); }
  } catch (cause) {
    if (cause instanceof KizukiError) throw cause;
    throw new KizukiError("misconfigured", "kizuki.ics: calendar file cannot be read", { cause });
  } finally { await handle.close(); }
}
