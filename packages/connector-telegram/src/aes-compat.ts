/**
 * MIT replacement for the `@cryptography/aes` surface that gramjs uses.
 *
 * gramjs imports two things from that GPL-3.0 package: the default `AES`
 * block cipher (for its CTR transport) and `IGE` (for MTProto message
 * encryption). The release build redirects that import here so the compiled
 * package carries only node:crypto. Both classes keep the upstream word
 * layout: 32-bit words are big-endian, as gramjs's converters expect.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";

type Input = string | Uint8Array | Uint32Array;

function bytes(value: Input): Buffer {
  if (typeof value === "string") return Buffer.from(value, "binary");
  if (value instanceof Uint32Array) {
    const out = Buffer.alloc(value.length * 4);
    for (let i = 0; i < value.length; i++) out.writeUInt32BE(value[i]! >>> 0, i * 4);
    return out;
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function words(value: Buffer): Uint32Array {
  const out = new Uint32Array(value.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = value.readUInt32BE(i * 4);
  return out;
}

function algorithm(key: Buffer): string {
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new Error("AES key must be 16, 24 or 32 bytes");
  }
  return `aes-${key.length * 8}-ecb`;
}

function block(key: Buffer, data: Buffer, decrypt: boolean): Buffer {
  const cipher = decrypt
    ? createDecipheriv(algorithm(key), key, null)
    : createCipheriv(algorithm(key), key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export default class AES {
  readonly #key: Buffer;

  constructor(key: Input) {
    this.#key = bytes(key);
    algorithm(this.#key);
  }

  encrypt(message: Input): Uint32Array {
    return words(block(this.#key, bytes(message), false));
  }

  decrypt(message: Input): Uint32Array {
    return words(block(this.#key, bytes(message), true));
  }
}

/** AES-IGE as used by MTProto: iv is 32 bytes, first half c₀, second half p₀. */
export class IGE {
  readonly #key: Buffer;
  readonly #iv: Buffer;

  constructor(key: Input, iv: Input) {
    this.#key = bytes(key);
    this.#iv = bytes(iv);
    algorithm(this.#key);
    if (this.#iv.length !== 32) throw new Error("IGE iv must be 32 bytes");
  }

  encrypt(message: Input): Uint32Array {
    return this.#run(bytes(message), false);
  }

  decrypt(message: Input): Uint32Array {
    return this.#run(bytes(message), true);
  }

  #run(data: Buffer, decrypt: boolean): Uint32Array {
    if (data.length % 16 !== 0) throw new Error("IGE input must be a multiple of 16 bytes");
    // Encrypt: c = E(p ^ cPrev) ^ pPrev. Decrypt: p = D(c ^ pPrev) ^ cPrev.
    let cPrev = Buffer.from(this.#iv.subarray(0, 16));
    let pPrev = Buffer.from(this.#iv.subarray(16, 32));
    const out = Buffer.alloc(data.length);
    for (let offset = 0; offset < data.length; offset += 16) {
      const inBlock = data.subarray(offset, offset + 16);
      const mask = decrypt ? pPrev : cPrev;
      const unmask = decrypt ? cPrev : pPrev;
      const mixed = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) mixed[i] = inBlock[i]! ^ mask[i]!;
      const result = block(this.#key, mixed, decrypt);
      for (let i = 0; i < 16; i++) out[offset + i] = result[i]! ^ unmask[i]!;
      const outBlock = out.subarray(offset, offset + 16);
      if (decrypt) {
        cPrev = Buffer.from(inBlock);
        pPrev = Buffer.from(outBlock);
      } else {
        pPrev = Buffer.from(inBlock);
        cPrev = Buffer.from(outBlock);
      }
    }
    return words(out);
  }
}

