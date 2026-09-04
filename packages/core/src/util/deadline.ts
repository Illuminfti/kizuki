export class DeadlineError extends Error {
  override readonly name = "DeadlineError";

  constructor(message: string) {
    super(message);
  }
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
