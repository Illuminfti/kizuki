import { writerHolderPid } from "@kizuki/core/internal";
import { UsageError } from "./args";
import type { CliIo } from "./commands/index";

/** How long tell and undo wait for the canon writer before they give up. */
export const DEFAULT_WRITER_WAIT_SECONDS = 30;
const MAX_WRITER_WAIT_SECONDS = 3600;
const FIRST_POLL_MS = 100;
const LAST_POLL_MS = 1_000;

export function parseWriterWait(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WRITER_WAIT_SECONDS;
  if (!/^[0-9]+$/.test(raw)) throw new UsageError("invalid --wait");
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_WRITER_WAIT_SECONDS) throw new UsageError("invalid --wait");
  return seconds;
}

function holder(vaultPath: string): string {
  const pid = writerHolderPid(vaultPath);
  return pid === null ? "another kizuki process" : `process ${pid}`;
}

/**
 * The canon writer is exclusive, and a sync pass holds it for the whole pass.
 * A correction or an undo is the owner's own act and should land, so a busy
 * writer is waited out for a bounded time rather than refused on first sight.
 * `run` fails on a busy writer before it changes anything, so retrying is safe.
 * Progress goes to stderr; stdout stays the command's own output.
 */
export async function waitForWriter<T>(
  io: Pick<CliIo, "err">,
  vaultPath: string,
  seconds: number,
  isBusy: (error: unknown) => boolean,
  run: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + seconds * 1_000;
  let poll = FIRST_POLL_MS;
  let announced = false;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!isBusy(error)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (seconds > 0) io.err(`canon writer is still busy after ${seconds}s (held by ${holder(vaultPath)}); retry, or raise --wait`);
        throw error;
      }
      if (!announced) {
        announced = true;
        io.err(`canon writer is busy (held by ${holder(vaultPath)}); waiting up to ${seconds}s`);
      }
      await Bun.sleep(Math.min(poll, remaining));
      poll = Math.min(Math.round(poll * 1.5), LAST_POLL_MS);
    }
  }
}
