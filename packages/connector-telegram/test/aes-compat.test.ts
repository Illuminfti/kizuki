import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import AES, { IGE } from "../src/aes-compat";

function hex(words: Uint32Array): string {
  const out = Buffer.alloc(words.length * 4);
  for (let i = 0; i < words.length; i++) out.writeUInt32BE(words[i]! >>> 0, i * 4);
  return out.toString("hex");
}

test("AES block matches the FIPS-197 AES-128 vector", () => {
  const key = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const pt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  expect(hex(new AES(key).encrypt(pt))).toBe("69c4e0d86a7b0430d8cdb78070b4c55a");
  expect(hex(new AES(key).decrypt(Buffer.from("69c4e0d86a7b0430d8cdb78070b4c55a", "hex")))).toBe(
    pt.toString("hex"),
  );
});

test("IGE matches the OpenSSL AES-128-IGE vector and round-trips", () => {
  const key = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const iv = Buffer.from(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "hex",
  );
  const pt = Buffer.alloc(32);
  const ct = hex(new IGE(key, iv).encrypt(pt));
  expect(ct).toBe("1a8519a6557be652e9da8e43da4ef4453cf456b4ca488aa383c79c98b34797cb");
  expect(hex(new IGE(key, iv).decrypt(Buffer.from(ct, "hex")))).toBe(pt.toString("hex"));
  for (let i = 0; i < 50; i++) {
    const k = randomBytes(32);
    const v = randomBytes(32);
    const m = randomBytes(16 * (1 + (i % 7)));
    const c = Buffer.from(hex(new IGE(k, v).encrypt(m)), "hex");
    expect(hex(new IGE(k, v).decrypt(c))).toBe(m.toString("hex"));
  }
});

test("rejects malformed keys and IGE lengths", () => {
  expect(() => new AES(Buffer.alloc(15))).toThrow();
  expect(() => new IGE(Buffer.alloc(16), Buffer.alloc(16))).toThrow();
  expect(() => new IGE(Buffer.alloc(16), Buffer.alloc(32)).encrypt(Buffer.alloc(15))).toThrow();
});
