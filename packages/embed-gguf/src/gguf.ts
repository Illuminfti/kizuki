import { readFileSync, statSync } from "node:fs";
import { PortError } from "@kizuki/core";

export const GGUF_MAGIC = "GGUF";
export const GGUF_VERSION = 3;
export const GGUF_ALIGNMENT = 32;
export const GGUF_F32 = 0;
export const TABLE_ARCHITECTURE = "kizuki-embedding";
export const UNSUPPORTED_TRANSFORMER_ARCHITECTURES = Object.freeze([
  "gemma",
  "gemma2",
  "gemma3",
  "llama",
  "qwen",
  "qwen2",
  "qwen3",
  "bert",
  "nomic-bert",
] as const);

export const MAX_GGUF_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = MAX_GGUF_FILE_BYTES;
const MAX_METADATA = 256;
const MAX_TENSORS = 32;
const MAX_STRING = 4096;
const MAX_ARRAY = 4096;
const MAX_DIMS = 4;
const MAX_VOCAB = 4096;
const MAX_DIMS_PRODUCT = 4 * 1024 * 1024;

const VALUE_UINT8 = 0;
const VALUE_INT8 = 1;
const VALUE_UINT16 = 2;
const VALUE_INT16 = 3;
const VALUE_UINT32 = 4;
const VALUE_INT32 = 5;
const VALUE_FLOAT32 = 6;
const VALUE_BOOL = 7;
const VALUE_STRING = 8;
const VALUE_ARRAY = 9;
const VALUE_UINT64 = 10;
const VALUE_INT64 = 11;
const VALUE_FLOAT64 = 12;

export type GgufValue =
  | number
  | boolean
  | string
  | bigint
  | readonly GgufValue[];

export interface GgufTensorInfo {
  readonly name: string;
  readonly dims: readonly number[];
  readonly type: number;
  readonly offset: number;
}

export interface GgufFile {
  readonly version: number;
  readonly metadata: Readonly<Record<string, GgufValue>>;
  readonly tensors: readonly GgufTensorInfo[];
  readonly tensor_data: Uint8Array;
}

export interface EmbeddingTable {
  readonly architecture: string;
  readonly name: string;
  readonly dims: number;
  readonly vocab: readonly string[];
  readonly weights: Float32Array;
}

function fail(message: string): never {
  throw new PortError("config_invalid", message, false);
}

export function assertGgufFileSize(size: number): void {
  if (size <= 0 || size > MAX_GGUF_FILE_BYTES) {
    fail("GGUF model size is outside the supported bound");
  }
}

function unavailable(message: string): never {
  throw new PortError("unavailable", message, false);
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  private need(count: number): void {
    if (count < 0 || this.offset + count > this.bytes.byteLength) {
      fail("GGUF file is truncated");
    }
  }

  readBytes(count: number): Uint8Array {
    this.need(count);
    const slice = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  readU8(): number {
    this.need(1);
    const value = this.bytes[this.offset];
    if (value === undefined) fail("GGUF file is truncated");
    this.offset += 1;
    return value;
  }

  readU16(): number {
    this.need(2);
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      2,
    );
    this.offset += 2;
    return view.getUint16(0, true);
  }

  readU32(): number {
    this.need(4);
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4,
    );
    this.offset += 4;
    return view.getUint32(0, true);
  }

  readU64(): number {
    this.need(8);
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8,
    );
    this.offset += 8;
    const value = view.getBigUint64(0, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("GGUF integer exceeds safe range");
    }
    return Number(value);
  }

  readF32(): number {
    this.need(4);
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4,
    );
    this.offset += 4;
    return view.getFloat32(0, true);
  }

  readF64(): number {
    this.need(8);
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8,
    );
    this.offset += 8;
    return view.getFloat64(0, true);
  }

  readString(): string {
    const length = this.readU64();
    if (length > MAX_STRING) fail("GGUF string is too long");
    return new TextDecoder().decode(this.readBytes(length));
  }

  skipTo(position: number): void {
    if (position < this.offset || position > this.bytes.byteLength) {
      fail("GGUF alignment is invalid");
    }
    this.offset = position;
  }

  position(): number {
    return this.offset;
  }
}

class Writer {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  writeBytes(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
  }

  writeU8(value: number): void {
    this.writeBytes(Uint8Array.of(value & 0xff));
  }

  writeU32(value: number): void {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setUint32(0, value, true);
    this.writeBytes(new Uint8Array(buffer));
  }

  writeU64(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("GGUF writer received an unsafe integer");
    }
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setBigUint64(0, BigInt(value), true);
    this.writeBytes(new Uint8Array(buffer));
  }

  writeF32(value: number): void {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setFloat32(0, value, true);
    this.writeBytes(new Uint8Array(buffer));
  }

  writeString(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.writeU64(encoded.byteLength);
    this.writeBytes(encoded);
  }

  align(alignment: number): void {
    const rem = this.length % alignment;
    if (rem === 0) return;
    this.writeBytes(new Uint8Array(alignment - rem));
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

function readValue(reader: Reader, type: number, depth = 0): GgufValue {
  if (depth > 2) fail("GGUF metadata nesting is too deep");
  switch (type) {
    case VALUE_UINT8:
    case VALUE_INT8:
    case VALUE_BOOL:
      return reader.readU8();
    case VALUE_UINT16:
    case VALUE_INT16:
      return reader.readU16();
    case VALUE_UINT32:
    case VALUE_INT32:
      return reader.readU32();
    case VALUE_FLOAT32:
      return reader.readF32();
    case VALUE_STRING:
      return reader.readString();
    case VALUE_UINT64:
    case VALUE_INT64:
      return reader.readU64();
    case VALUE_FLOAT64:
      return reader.readF64();
    case VALUE_ARRAY: {
      const itemType = reader.readU32();
      const count = reader.readU64();
      if (count > MAX_ARRAY) fail("GGUF array is too large");
      const items: GgufValue[] = [];
      for (let index = 0; index < count; index += 1) {
        items.push(readValue(reader, itemType, depth + 1));
      }
      return items;
    }
    default:
      fail("GGUF metadata type is unsupported");
  }
}

function writeValue(writer: Writer, type: number, value: GgufValue): void {
  switch (type) {
    case VALUE_UINT32:
      if (typeof value !== "number") fail("GGUF uint32 value is invalid");
      writer.writeU32(value);
      return;
    case VALUE_STRING:
      if (typeof value !== "string") fail("GGUF string value is invalid");
      writer.writeString(value);
      return;
    case VALUE_ARRAY: {
      if (!Array.isArray(value)) fail("GGUF array value is invalid");
      writer.writeU32(VALUE_STRING);
      writer.writeU64(value.length);
      for (const item of value) {
        if (typeof item !== "string") fail("GGUF string array is invalid");
        writer.writeString(item);
      }
      return;
    }
    default:
      fail("GGUF writer type is unsupported");
  }
}

export function parseGguf(bytes: Uint8Array): GgufFile {
  if (bytes.byteLength > MAX_FILE_BYTES) {
    fail("GGUF file exceeds the table-embedding size bound");
  }
  const reader = new Reader(bytes);
  const magic = new TextDecoder().decode(reader.readBytes(4));
  if (magic !== GGUF_MAGIC) fail("file is not a GGUF model");
  const version = reader.readU32();
  if (version !== GGUF_VERSION) fail(`unsupported GGUF version ${version}`);
  const tensorCount = reader.readU64();
  const metadataCount = reader.readU64();
  if (tensorCount > MAX_TENSORS) fail("GGUF tensor count is too large");
  if (metadataCount > MAX_METADATA) fail("GGUF metadata count is too large");

  const metadata: Record<string, GgufValue> = {};
  for (let index = 0; index < metadataCount; index += 1) {
    const key = reader.readString();
    const type = reader.readU32();
    metadata[key] = readValue(reader, type);
  }

  const tensors: GgufTensorInfo[] = [];
  for (let index = 0; index < tensorCount; index += 1) {
    const name = reader.readString();
    const nDims = reader.readU32();
    if (nDims < 1 || nDims > MAX_DIMS) fail("GGUF tensor rank is invalid");
    const dims: number[] = [];
    let product = 1;
    for (let dim = 0; dim < nDims; dim += 1) {
      const size = reader.readU64();
      if (size < 1) fail("GGUF tensor dimension is invalid");
      dims.push(size);
      product *= size;
      if (product > MAX_DIMS_PRODUCT) fail("GGUF tensor is too large");
    }
    const type = reader.readU32();
    const offset = reader.readU64();
    tensors.push({ name, dims, type, offset });
  }

  const rem = reader.position() % GGUF_ALIGNMENT;
  if (rem !== 0) reader.skipTo(reader.position() + (GGUF_ALIGNMENT - rem));
  return {
    version,
    metadata,
    tensors,
    tensor_data: bytes.subarray(reader.position()),
  };
}

export function readGgufFile(path: string): GgufFile {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    unavailable(`GGUF model is missing: ${path}`);
  }
  if (!stat.isFile()) unavailable(`GGUF model is not a file: ${path}`);
  assertGgufFileSize(stat.size);
  return parseGguf(readFileSync(path));
}

function stringMeta(
  metadata: Readonly<Record<string, GgufValue>>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberMeta(
  metadata: Readonly<Record<string, GgufValue>>,
  key: string,
): number | undefined {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArrayMeta(
  metadata: Readonly<Record<string, GgufValue>>,
  key: string,
): string[] | undefined {
  const value = metadata[key];
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((item) => typeof item === "string" && item.length > 0)) {
    return undefined;
  }
  return value as string[];
}

export function isTransformerArchitecture(architecture: string): boolean {
  const lowered = architecture.toLocaleLowerCase("en-US");
  return UNSUPPORTED_TRANSFORMER_ARCHITECTURES.some(
    (name) => lowered === name || lowered.startsWith(`${name}-`),
  );
}

export function loadEmbeddingTable(file: GgufFile): EmbeddingTable {
  const architecture =
    stringMeta(file.metadata, "general.architecture") ?? "";
  if (architecture.length === 0) fail("GGUF general.architecture is missing");
  if (isTransformerArchitecture(architecture)) {
    throw new PortError(
      "not_supported",
      `transformer GGUF architecture ${architecture} requires a native runtime that is not bound`,
      false,
    );
  }
  if (architecture !== TABLE_ARCHITECTURE) {
    throw new PortError(
      "not_supported",
      `GGUF architecture ${architecture} is not a table-embedding model`,
      false,
    );
  }

  const name = stringMeta(file.metadata, "general.name") ?? "";
  if (name.length === 0) fail("GGUF general.name is missing");

  const dims =
    numberMeta(file.metadata, "embedding.embedding_length") ??
    numberMeta(file.metadata, `${architecture}.embedding_length`);
  if (
    dims === undefined ||
    !Number.isSafeInteger(dims) ||
    dims < 1 ||
    dims > 4096
  ) {
    fail("GGUF embedding length is missing or invalid");
  }

  const vocab = stringArrayMeta(file.metadata, "tokenizer.ggml.tokens");
  if (vocab === undefined || vocab.length > MAX_VOCAB) {
    fail("GGUF tokenizer vocab is missing or too large");
  }

  const tensor = file.tensors.find(
    (entry) => entry.name === "token_embd.weight",
  );
  if (tensor === undefined) fail("GGUF token_embd.weight is missing");
  if (tensor.type !== GGUF_F32) fail("GGUF token_embd.weight must be F32");
  if (tensor.dims.length !== 2) fail("GGUF token_embd.weight rank is invalid");

  const [inner, outer] = tensor.dims;
  if (inner === undefined || outer === undefined) {
    fail("GGUF token_embd.weight dims are invalid");
  }
  const nEmb =
    inner === dims ? inner : outer === dims ? outer : undefined;
  const nVocab =
    inner === vocab.length
      ? inner
      : outer === vocab.length
        ? outer
        : undefined;
  if (nEmb !== dims || nVocab !== vocab.length) {
    fail("GGUF token_embd.weight shape does not match vocab and dims");
  }

  const byteOffset = tensor.offset;
  const byteLength = nVocab * nEmb * 4;
  if (
    byteOffset < 0 ||
    byteOffset + byteLength > file.tensor_data.byteLength
  ) {
    fail("GGUF token_embd.weight data is truncated");
  }
  const raw = file.tensor_data.subarray(byteOffset, byteOffset + byteLength);
  const aligned = new ArrayBuffer(byteLength);
  new Uint8Array(aligned).set(raw);
  const weights = new Float32Array(aligned);
  if (weights.length !== nVocab * nEmb) {
    fail("GGUF token_embd.weight length is inconsistent");
  }
  return { architecture, name, dims, vocab, weights };
}

export function writeEmbeddingTableGguf(table: EmbeddingTable): Uint8Array {
  if (
    table.architecture.length === 0 ||
    table.vocab.length === 0 ||
    table.vocab.length > MAX_VOCAB ||
    table.dims < 1 ||
    table.weights.length !== table.vocab.length * table.dims
  ) {
    fail("fixture GGUF table is invalid");
  }

  const metadata: [string, number, GgufValue][] = [
    ["general.architecture", VALUE_STRING, table.architecture],
    ["general.name", VALUE_STRING, table.name],
    ["embedding.embedding_length", VALUE_UINT32, table.dims],
    ["tokenizer.ggml.model", VALUE_STRING, "kizuki-whitespace"],
    ["tokenizer.ggml.tokens", VALUE_ARRAY, table.vocab],
  ];

  const header = new Writer();
  header.writeBytes(new TextEncoder().encode(GGUF_MAGIC));
  header.writeU32(GGUF_VERSION);
  header.writeU64(1);
  header.writeU64(metadata.length);
  for (const [key, type, value] of metadata) {
    header.writeString(key);
    header.writeU32(type);
    writeValue(header, type, value);
  }
  header.writeString("token_embd.weight");
  header.writeU32(2);
  header.writeU64(table.dims);
  header.writeU64(table.vocab.length);
  header.writeU32(GGUF_F32);
  header.writeU64(0);
  header.align(GGUF_ALIGNMENT);

  const headerBytes = header.toBytes();
  const weightBytes = new Uint8Array(
    table.weights.buffer,
    table.weights.byteOffset,
    table.weights.byteLength,
  );
  const out = new Uint8Array(headerBytes.byteLength + weightBytes.byteLength);
  out.set(headerBytes, 0);
  out.set(weightBytes, headerBytes.byteLength);
  return out;
}
