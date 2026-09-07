import { strict as assert } from "node:assert";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ptr } from "bun:ffi";
import { openOwnedDirectory } from "../../packages/core/src/util/owned-directory";
import { loadOwnedDirectoryNative } from "../../packages/core/src/util/owned-directory-native";

function name(value: string | readonly number[]): Buffer {
  return Buffer.concat([Buffer.from(value), Buffer.from([0])]);
}

function openDirectory(path: string): number {
  return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

function nativeFd(value: number | bigint): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`expected a native file descriptor, got ${value}`);
  }
  return value;
}

function expectNegative(value: number | bigint): void {
  if (typeof value !== "number" || value >= 0) throw new Error(`expected a native refusal, got ${value}`);
}

function sameIdentity(path: string, identity: { dev: bigint; ino: bigint }): void {
  const stat = lstatSync(path, { bigint: true });
  assert.equal(stat.dev, identity.dev);
  assert.equal(stat.ino, identity.ino);
}

const root = process.env.KIZUKI_DARWIN_CANARY_ROOT;
if (process.platform !== "darwin" || process.arch !== "arm64" || !root) {
  throw new Error("darwin native canary requires macOS arm64 and an isolated root");
}

mkdirSync(root, { recursive: true, mode: 0o700 });
const api = loadOwnedDirectoryNative();
const parentFd = openDirectory(root);
try {
  const symbols = api.symbols;
  const credential = name("credential");
  const receipt = name("receipt");
  const source = name("source");
  const destination = name("destination");
  const opaque = name([0xc3, 0xbf]);

  const credentialFd = nativeFd(symbols.createCredentialChild(parentFd, ptr(credential)));
  try {
    writeFileSync(credentialFd, "credential", { encoding: "utf8" });
    const stat = fstatSync(credentialFd, { bigint: true });
    assert.ok(stat.isFile());
    assert.equal(stat.mode & 0o777n, 0o600n);
  } finally { closeSync(credentialFd); }

  const opened = nativeFd(symbols.openChild(parentFd, ptr(credential), 0));
  try {
    const expected = lstatSync(join(root, "credential"), { bigint: true });
    const observed = fstatSync(opened, { bigint: true });
    assert.equal(observed.dev, expected.dev);
    assert.equal(observed.ino, expected.ino);
  } finally { closeSync(opened); }

  const metadata = Buffer.alloc(144);
  assert.equal(symbols.statChild(parentFd, ptr(credential), ptr(metadata)), 0);
  const expectedMetadata = lstatSync(join(root, "credential"), { bigint: true });
  assert.equal(metadata.readBigUInt64LE(0), expectedMetadata.dev);
  assert.equal(metadata.readBigUInt64LE(8), expectedMetadata.ino);
  assert.equal(metadata.readBigUInt64LE(16), expectedMetadata.nlink);
  assert.equal(BigInt(metadata.readUInt32LE(24)), expectedMetadata.mode);
  assert.equal(BigInt(metadata.readUInt32LE(28)), expectedMetadata.uid);
  assert.equal(BigInt(metadata.readUInt32LE(32)), expectedMetadata.gid);
  assert.equal(metadata.readBigInt64LE(48), expectedMetadata.size);
  assert.equal(metadata.readBigInt64LE(88) * 1_000_000_000n + metadata.readBigInt64LE(96), expectedMetadata.mtimeNs);
  assert.equal(metadata.readBigInt64LE(104) * 1_000_000_000n + metadata.readBigInt64LE(112), expectedMetadata.ctimeNs);

  const append = nativeFd(symbols.openReceiptAppendChild(parentFd, ptr(receipt), 1));
  try { writeFileSync(append, "first\n", { encoding: "utf8" }); } finally { closeSync(append); }
  const readAppend = nativeFd(symbols.openReceiptReadAppendChild(parentFd, ptr(receipt), 0));
  try { writeFileSync(readAppend, "second\n", { encoding: "utf8" }); } finally { closeSync(readAppend); }
  assert.equal(readFileSync(join(root, "receipt"), "utf8"), "first\nsecond\n");

  assert.equal(symbols.mkdirChild(parentFd, ptr(source)), 0);
  assert.equal(symbols.renameChildNoReplace(parentFd, ptr(source), parentFd, ptr(destination)), 0);
  assert.equal(symbols.mkdirChild(parentFd, ptr(source)), 0);
  assert.equal(symbols.renameChildNoReplace(parentFd, ptr(source), parentFd, ptr(destination)), -17);
  assert.equal(symbols.removeEmptyChild(parentFd, ptr(source)), 0);
  assert.equal(symbols.removeEmptyChild(parentFd, ptr(destination)), 0);

  // The native Mac volume rejects malformed UTF-8; the adapter preserves that
  // refusal. Valid multibyte names still travel through the byte-oriented seam.
  assert.equal(symbols.createCredentialChild(parentFd, ptr(name([0x80, 0xff]))), -92 /* EILSEQ */);
  const opaqueFd = nativeFd(symbols.createCredentialChild(parentFd, ptr(opaque)));
  closeSync(opaqueFd);
  assert.equal(symbols.mkdirChild(parentFd, ptr(source)), 0);
  const owned = openOwnedDirectory(root);
  try {
    assert.equal(owned.isEmpty(), false, "opaque directory entry was not enumerated");
    const identity = owned.childIdentity("source");
    assert.ok(identity);
    sameIdentity(join(root, "source"), identity);
  } finally { owned.close(); }
  assert.equal(symbols.removeEmptyChild(parentFd, ptr(source)), 0);
  assert.equal(symbols.unlinkChild(parentFd, ptr(opaque)), 0);

  symlinkSync("credential", join(root, "link"));
  expectNegative(symbols.openChild(parentFd, ptr(name("link")), 0));
  assert.equal(symbols.unlinkChild(parentFd, ptr(name("link"))), 0);
  assert.equal(symbols.unlinkChild(parentFd, ptr(credential)), 0);
  assert.equal(symbols.unlinkChild(parentFd, ptr(receipt)), 0);
} finally {
  closeSync(parentFd);
  api.compiled.close();
  api.libc.close();
}

process.stdout.write("darwin-native-canary: passed\n");
