import { randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { PortError } from "@kizuki/core";
import type { EmbeddingSpace } from "@kizuki/core";
import { loadEmbeddingTable, parseGguf, TABLE_ARCHITECTURE } from "./gguf";
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
}

export interface InstalledGgufModel {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly space: EmbeddingSpace;
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

  const bytes = readFileSync(input.source_path);
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
    try {
      renameSync(temp, dest);
    } catch {
      copyFileSync(temp, dest);
      unlinkSync(temp);
    }
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch (cleanupError) {
      if (errnoCode(cleanupError) !== "ENOENT") throw cleanupError;
    }
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

function writeExclusivePartial(dest: string, bytes: Uint8Array): string {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temp = installPartialPath(dest);
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
      return temp;
    } catch (error) {
      if (errnoCode(error) === "EEXIST") continue;
      throw error;
    }
  }
  unavailable("could not create an exclusive GGUF install temporary");
}
