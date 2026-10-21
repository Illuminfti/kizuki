export class DeadlineError extends Error {
  override readonly name = "DeadlineError";

  constructor(message: string) {
    super(message);
  }
}

/** End a wait on cancellation; the caller must prevent late work from publishing. */
export function withAbortSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work;
  let abort!: () => void;
  return new Promise<T>((resolve, reject) => {
    abort = () => reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject);
    if (signal.aborted) abort();
  }).finally(() => signal.removeEventListener("abort", abort));
}

/**
 * Host-side timer around a connector promise. The connector API has no
 * AbortSignal; this is what stops a hung provider from owning the rail.
 */
export function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("withDeadline: timeoutMs must be a positive integer");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineError(message));
    }, timeoutMs);
    work.then(resolve, reject);
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
