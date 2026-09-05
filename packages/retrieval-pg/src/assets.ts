import { PortError } from "@kizuki/core";
import { PGlite } from "@electric-sql/pglite";
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import wasm from "../node_modules/@electric-sql/pglite/dist/pglite.wasm" with { type: "file" };
import initdb from "../node_modules/@electric-sql/pglite/dist/initdb.wasm" with { type: "file" };
import data from "../node_modules/@electric-sql/pglite/dist/pglite.data" with { type: "file" };
import vector from "../node_modules/@electric-sql/pglite-pgvector/dist/vector.tar.gz" with { type: "file" };
import trgm from "../node_modules/@electric-sql/pglite/dist/pg_trgm.tar.gz" with { type: "file" };
export const EXTENSION_HASHES = {
  vector: "881caf1c550dc4ecde6bfae95018d90684c6a61189273f13e0071595819513a2",
  trgm: "4e76ac1614c092647846eecdbb1f7e8453113d5b326c3113984155b4f780e534",
};
let coreAssets: Promise<{
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
  fsBundle: Blob;
}> | undefined;
function loadCore() {
  return coreAssets ??= (async () => {
    async function checked(path: string, hash: string) {
      const bytes = await Bun.file(path).arrayBuffer();
      if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== hash) {
        throw new PortError("unavailable", "retrieval core asset integrity mismatch", false);
      }
      return bytes;
    }
    return {
      pgliteWasmModule: new WebAssembly.Module(await checked(wasm, "356b89f6fcb2ab3a397bec4128327b67b7137ec2a900b13251dade81bcbc0ef0")),
      initdbWasmModule: new WebAssembly.Module(await checked(initdb, "4c8988dca3b2f0bbfd23a0714023e4822a2909ead01804f37acffd9ff3ca9f8a")),
      fsBundle: new Blob([await checked(data, "c574cc331d96e33311470ec57bf58c579d972c111dbd9c0ab54bb42d79ec4c0d")]),
    };
  })();
}
/** Statically bundled assets; extensions use the documented local bundlePath API. */
export async function openDatabase(dataDir: string): Promise<{
  db: PGlite;
  dispose(): void;
}> {
  for(const path of [dataDir,join(dataDir,"store"),join(dataDir,"store","pgdata")]) {
    try { if(lstatSync(path).isSymbolicLink())throw new PortError("config_invalid","retrieval storage directory must not be a symlink",false); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error; }
  }
  mkdirSync(join(dataDir, "store"), { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(dataDir, "assets-"));
  chmodSync(directory, 0o700);
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  async function extension(name: "vector" | "trgm", source: string) {
    const path = join(directory, `${name}.tar.gz`);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, new Uint8Array(await Bun.file(source).arrayBuffer()));
      fsyncSync(fd);
    }
    finally {
      closeSync(fd);
    }
    if (new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex") !== EXTENSION_HASHES[name]) {
      throw new Error("retrieval extension asset integrity mismatch");
    }
    return { name: name === "trgm" ? "pg_trgm" : name, setup: async () => ({ bundlePath: pathToFileURL(path) }) };
  }
  try {
    const db = await PGlite.create(join(dataDir, "store", "pgdata"), {
      ...await loadCore(),
      extensions: { vector: await extension("vector", vector), pg_trgm: await extension("trgm", trgm) },
    });
    return { db, dispose };
  }
  catch (error) {
    dispose();
    throw error;
  }
}
