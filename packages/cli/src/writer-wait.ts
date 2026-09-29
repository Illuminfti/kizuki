import { CorrectError, ServeError, UndoError } from "@kizuki/core";

/** How long an owner verb waits for a canon write in progress before it reports the writer busy. */
export const WRITER_WAIT_MS = 30_000;
const POLL_MS = 25;

function writerBusy(error: unknown): boolean {
  if (error instanceof CorrectError || error instanceof UndoError) return error.code === "writer_busy";
  return error instanceof ServeError && error.retry_after_seconds !== null && error.message.startsWith("canon writer is busy");
}

/**
 * Runs an owner verb, trying again while another canon write holds the writer.
 * A busy writer refuses before the verb does anything, so a retry repeats no
 * effect. The sync pass lets the writer go between pages, so the wait is one
 * page at most, not a whole pass.
 */
export async function whileWriterBusy<T>(work: () => Promise<T>, waitMs = WRITER_WAIT_MS): Promise<T> {
  const deadline = performance.now() + waitMs;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      if (!writerBusy(error) || performance.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}
