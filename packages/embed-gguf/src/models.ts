import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
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
  const temp = `${dest}.partial`;
  writeFileSync(temp, bytes, { mode: 0o600 });
  try {
    renameSync(temp, dest);
  } catch {
    copyFileSync(temp, dest);
  }

  return Object.freeze({
    path: dest,
    bytes: stat.size,
    sha256,
    space,
  });
}
