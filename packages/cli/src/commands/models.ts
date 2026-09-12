import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  GGUF_MODEL_CATALOG,
  MAX_GGUF_FILE_BYTES,
  catalogRemoteAcquisition,
  findGgufCatalogEntry,
  installGgufModel,
  listInstalledGgufModels,
  removeInstalledGgufModel,
  vaultModelsDir,
} from "@kizuki/embed-gguf";
import { PortError } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { assertVault, resolveVault } from "../context";
import { configPath, readConfig } from "../config";
import type { CliIo, Command, CommandHelpSchema } from "./index";

export const MODELS_SCHEMA = {
  options: ["--from", "--sha256", "--bytes"],
  flags: ["--catalog"],
} as const satisfies CommandHelpSchema;

const USAGE =
  "models <list [--catalog] | pull <CATALOG_ID | --from PATH|URL [--sha256 HEX] [--bytes N]> | remove NAME>";

function modelsDir(io: CliIo): string {
  const path = configPath(io.env);
  const config = readConfig(path);
  return vaultModelsDir(assertVault(resolveVault(io.env, config, io.vaultOverride)));
}

function remotePullUrl(from: string): URL | null {
  let url: URL;
  try {
    url = new URL(from);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}

async function downloadRemoteGguf(
  url: URL,
  expectedBytes: number,
  expectedSha256: string,
): Promise<string> {
  if (expectedBytes > MAX_GGUF_FILE_BYTES) {
    throw new Error(`GGUF source size does not match expected bytes`);
  }
  const filename = basename(url.pathname);
  if (!filename.endsWith(".gguf") || filename.includes("\0")) {
    throw new UsageError(USAGE);
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`models pull failed: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== expectedBytes) {
    throw new Error("GGUF source size does not match expected bytes");
  }
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error("GGUF source hash does not match expected sha256");
  }
  const dir = join(
    tmpdir(),
    `kizuki-model.${process.pid}.${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, filename);
  writeFileSync(temp, bytes, { mode: 0o600 });
  return temp;
}

export const modelsCommand: Command = {
  name: "models",
  usage: USAGE,
  summary: "list, install, or remove local GGUF files in the vault models directory",
  schema: MODELS_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const verb = args[0];
    const rest = args.slice(1);
    if (verb === "list") {
      const parsed = parseArguments(rest, { flags: [...MODELS_SCHEMA.flags] });
      if (parsed.positionals.length > 0) throw new UsageError(this.usage);
      if (parsed.flags.has("--catalog")) {
        for (const entry of GGUF_MODEL_CATALOG) {
          io.out(`id=${entry.id}`);
          io.out(`filename=${entry.filename}`);
          io.out(`architecture=${entry.architecture}`);
          io.out(`dims=${entry.dims}`);
          const remote = catalogRemoteAcquisition(entry);
          io.out(remote === null ? "remote=no" : "remote=yes");
        }
        return 0;
      }
      for (const model of listInstalledGgufModels(modelsDir(io))) {
        io.out(`filename=${model.filename}`);
        io.out(`path=${model.path}`);
        io.out(`bytes=${model.bytes}`);
        io.out(`sha256=${model.sha256}`);
      }
      return 0;
    }
    if (verb === "remove") {
      if (rest.length !== 1) throw new UsageError(this.usage);
      const removed = removeInstalledGgufModel(modelsDir(io), rest[0]!);
      io.out(`removed=${removed}`);
      return 0;
    }
    if (verb !== "pull") {
      throw new UsageError(this.usage);
    }

    const parsed = parseArguments(rest, {
      options: [...MODELS_SCHEMA.options],
    });
    const from = parsed.options.get("--from");
    const catalogId = parsed.positionals[0];
    if (parsed.positionals.length > 1) {
      throw new UsageError(this.usage);
    }
    if (catalogId !== undefined && from !== undefined) {
      io.err("error: models pull CATALOG_ID cannot be combined with --from");
      throw new UsageError(this.usage);
    }
    if (catalogId === undefined && (from === undefined || from.length === 0)) {
      io.err(
        "error: models pull requires a catalog id or --from PATH; this command does not download weights",
      );
      throw new UsageError(this.usage);
    }

    const expected = parsed.options.get("--sha256");
    const bytesOpt = parsed.options.get("--bytes");
    let expectedBytes: number | undefined;
    if (bytesOpt !== undefined) {
      if (!/^[1-9][0-9]*$/.test(bytesOpt)) {
        throw new UsageError(this.usage);
      }
      expectedBytes = Number(bytesOpt);
    }

    const remote = remotePullUrl(from ?? "");
    let sourcePath = from === undefined ? "" : resolve(from);
    let cleanup: string | undefined;
    if (catalogId !== undefined) {
      if (expected !== undefined || expectedBytes !== undefined) {
        io.err("error: models pull CATALOG_ID cannot override catalog pins");
        throw new UsageError(this.usage);
      }
      let acquisition;
      try {
        acquisition = catalogRemoteAcquisition(findGgufCatalogEntry(catalogId));
      } catch (error) {
        if (error instanceof PortError && error.code === "config_invalid") {
          io.err(`error: ${error.message}`);
          throw new UsageError(this.usage);
        }
        throw error;
      }
      if (acquisition === null) {
        io.err(
          "error: catalog entry has no remote acquisition pins; this command does not download weights",
        );
        throw new UsageError(this.usage);
      }
      cleanup = await downloadRemoteGguf(acquisition.url, acquisition.bytes, acquisition.sha256);
      sourcePath = cleanup;
    } else if (remote !== null) {
      if (expected === undefined || expectedBytes === undefined) {
        io.err(
          "error: models pull from a URL requires --sha256 and --bytes; this command does not download weights without them",
        );
        throw new UsageError(this.usage);
      }
      cleanup = await downloadRemoteGguf(remote, expectedBytes, expected);
      sourcePath = cleanup;
    }

    try {
      const installed = installGgufModel({
        source_path: sourcePath,
        dest_dir: modelsDir(io),
        ...(expected === undefined ? {} : { expected_sha256: expected }),
        ...(expectedBytes === undefined ? {} : { expected_bytes: expectedBytes }),
      });

      io.out(`path=${installed.path}`);
      io.out(`bytes=${installed.bytes}`);
      io.out(`sha256=${installed.sha256}`);
      io.out(`space=${installed.space.id}`);
      return 0;
    } finally {
      if (cleanup !== undefined) {
        rmSync(dirname(cleanup), { recursive: true, force: true });
      }
    }
  },
};
