import { AS_OF } from "./persona";

export function assertLogicalClock(): void {
  if (Date.now() !== Date.parse(AS_OF) || new Date().toISOString() !== AS_OF) throw new Error("benchmark requires its isolated logical clock");
}

/** Install only in an isolated benchmark process, before importing product code. */
export function installLogicalClock(at: string): void {
  const instant = Date.parse(at);
  if (!Number.isFinite(instant)) throw new Error("invalid logical clock");
  const NativeDate = globalThis.Date;
  globalThis.Date = new Proxy(NativeDate, {
    apply: () => new NativeDate(instant).toString(),
    construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [instant] : args, newTarget),
    get: (target, key, receiver) => key === "now" ? () => instant : Reflect.get(target, key, receiver),
  });
}
