import nodeCrypto, { createHash } from "node:crypto";
import { mock } from "bun:test";

/** Predictable fixture bytes: install only in the isolated synthetic worker. */
export function installFixtureEntropy(): void {
  let counter = 0;
  function randomBytes(size: number): Buffer<ArrayBuffer>;
  function randomBytes(size: number, callback: (error: Error | null, bytes: Buffer<ArrayBuffer>) => void): void;
  function randomBytes(size: number, callback?: (error: Error | null, bytes: Buffer<ArrayBuffer>) => void) {
    const bytes = Buffer.alloc(size);
    for (let offset = 0; offset < size; offset += 32) {
      createHash("sha256").update(`kizuki.fresh-agent-fixture/v1:${counter++}`).digest().copy(bytes, offset);
    }
    if (callback !== undefined) { process.nextTick(callback, null, bytes); return; }
    return bytes;
  }
  const randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  globalThis.crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (array === null || !ArrayBuffer.isView(array) || array instanceof DataView || array instanceof Float32Array || array instanceof Float64Array) {
      throw new TypeError("fixture entropy requires an integer typed array");
    }
    if (array.byteLength > 65_536) throw new DOMException("fixture entropy request too large", "QuotaExceededError");
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(randomBytes(array.byteLength));
    return array;
  };
  globalThis.crypto.randomUUID = randomUUID;
  // Bun's named builtin imports retain their original functions when the
  // default export is mutated. Replace the two exports before Core loads.
  const fixtureCrypto = { ...nodeCrypto, randomBytes, randomUUID };
  mock.module("node:crypto", () => ({ ...fixtureCrypto, default: fixtureCrypto }));
}
