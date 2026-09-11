import { randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { PortError } from "@kizuki/core";
import type { EmbeddingSpace } from "@kizuki/core";
import {
  assertGgufFileSize,
  loadEmbeddingTable,
  parseGguf,
  TABLE_ARCHITECTURE,
} from "./gguf";
import { spaceFromTable } from "./space";

export interface GgufModelCatalogEntry {
  readonly id: string;
  readonly filename: string;
  readonly architecture: string;
  readonly dims: number;
  readonly notes: string;
}

export const GGUF_MODEL_CATALOG: readonly GgufModelCatalogEntry[] = Object.freeze([
  {
    id: "kizuki-fixture-embed",
    filename: "kizuki-fixture-embed.gguf",
    architecture: TABLE_ARCHITECTURE,
    dims: 8,
    notes: "Synthetic table-embedding fixture. Not a downloaded weight file.",
  },
]);

export interface InstallGgufModelInput {
  readonly source_path: string;
  readonly dest_dir: string;
  readonly expected_sha256?: string;
  readonly expected_bytes?: number;
}

export interface InstalledGgufModel {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly space: EmbeddingSpace;
}

export interface ListedGgufModel {
  readonly filename: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

function invalid(message: string): never {
  throw new PortError("config_invalid", message, false);
}

function unavailable(message: string): never {
  throw new PortError("unavailable", message, false);
}

function errnoCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

export function sha256File(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

export function vaultModelsDir(vaultPath: string): string {
  if (!isAbsolute(vaultPath)) invalid("vault path must be absolute");
  return join(vaultPath, ".kizuki", "models");
}

function ownedGgufFilename(name: string): string {
  if (name !== basename(name) || name.includes("\0") || name === "." || name === "..") {
    invalid("model name must be an exact installed filename");
  }
  if (!name.endsWith(".gguf")) invalid("model name must be an exact installed GGUF filename");
  return name;
}

function ownedModelPath(destDir: string, filename: string): string {
  if (!isAbsolute(destDir)) invalid("model destination directory must be absolute");
  let stat;
  try {
    stat = lstatSync(destDir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") unavailable(`GGUF model is missing: ${filename}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    invalid("models directory must be a regular directory");
  }
  return join(destDir, filename);
}

export function listInstalledGgufModels(destDir: string): ListedGgufModel[] {
  if (!isAbsolute(destDir)) invalid("model destination directory must be absolute");
  let dirStat;
  try {
    dirStat = lstatSync(destDir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    invalid("models directory must be a regular directory");
  }
  const listed: ListedGgufModel[] = [];
  for (const entry of readdirSync(destDir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".gguf") || entry.name.includes("\0")) continue;
    const path = join(destDir, entry.name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    listed.push({
      filename: entry.name,
      path,
      bytes: stat.size,
      sha256: sha256File(path),
    });
  }
  listed.sort((left, right) => (left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0));
  return listed;
}

export function removeInstalledGgufModel(destDir: string, filename: string): string {
  const name = ownedGgufFilename(filename);
  const dest = ownedModelPath(destDir, name);
  let stat;
  try {
    stat = lstatSync(dest);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") unavailable(`GGUF model is missing: ${name}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    invalid("model name must name a regular installed GGUF file");
  }
  unlinkSync(dest);
  return dest;
}

export function installGgufModel(
  input: InstallGgufModelInput,
): InstalledGgufModel {
  if (!isAbsolute(input.source_path)) {
    invalid("model source path must be absolute");
  }
  if (!isAbsolute(input.dest_dir)) {
    invalid("model destination directory must be absolute");
  }

  let stat;
  try {
    stat = statSync(input.source_path);
  } catch {
    unavailable(`GGUF source is missing: ${input.source_path}`);
  }
  if (!stat.isFile()) unavailable("GGUF source is not a file");
  assertGgufFileSize(stat.size);

  const bytes = readFileSync(input.source_path);
  if (
    input.expected_bytes !== undefined &&
    bytes.byteLength !== input.expected_bytes
  ) {
    throw new PortError(
      "config_invalid",
      "GGUF source size does not match expected bytes",
      false,
    );
  }
  const table = loadEmbeddingTable(parseGguf(bytes));
  const space = spaceFromTable(table);
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (
    input.expected_sha256 !== undefined &&
    input.expected_sha256 !== sha256
  ) {
    throw new PortError(
      "config_invalid",
      "GGUF source hash does not match expected sha256",
      false,
    );
  }

  mkdirSync(input.dest_dir, { recursive: true, mode: 0o700 });
  const filename = basename(input.source_path);
  if (!filename.endsWith(".gguf") || filename.includes("\0")) {
    invalid("GGUF source filename is invalid");
  }
  const dest = join(input.dest_dir, filename);
  const temp = writeExclusivePartial(dest, bytes);
  try {
    renameSync(temp, dest);
  } catch (error) {
    removeIfPresent(temp);
    throw error;
  }

  return Object.freeze({
    path: dest,
    bytes: stat.size,
    sha256,
    space,
  });
}

export function installPartialPath(dest: string): string {
  return `${dest}.${process.pid}.${randomBytes(8).toString("hex")}.partial`;
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) {
      unavailable("GGUF install write did not complete");
    }
    offset += written;
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

function writeExclusivePartial(dest: string, bytes: Uint8Array): string {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temp = installPartialPath(dest);
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeAll(fd, bytes);
      } catch (error) {
        closeSync(fd);
        removeIfPresent(temp);
        throw error;
      }
      closeSync(fd);
      return temp;
    } catch (error) {
      if (errnoCode(error) === "EEXIST") continue;
      throw error;
    }
  }
  unavailable("could not create an exclusive GGUF install temporary");
}
