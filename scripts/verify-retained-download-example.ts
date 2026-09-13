/** Documented local readback. It does not install, extract, download, or approve a release. */
import { readFileSync } from "node:fs";
import { DOWNLOAD_LIMITS, parseDownloadManifest, verifyDownloadArchive } from "./release-download";

function required(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function bounded(path: string, limit: number): Buffer {
  const bytes = readFileSync(path);
  if (bytes.byteLength > limit) throw new Error("input_too_large");
  return bytes;
}

const source = required("--source");
const target = required("--target");
const manifest = parseDownloadManifest(
  bounded(required("--manifest"), DOWNLOAD_LIMITS.manifest),
  source,
);
verifyDownloadArchive(
  manifest,
  target,
  bounded(required("--archive"), DOWNLOAD_LIMITS.archive),
  bounded(required("--proof"), DOWNLOAD_LIMITS.proof),
);
process.stdout.write("integrity_ok\n");
