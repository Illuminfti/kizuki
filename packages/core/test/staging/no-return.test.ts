import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import * as core from "../../src/index";
import * as staging from "../../src/staging/index";
import { sourceFiles } from "../canon/helpers";

const PACKAGES = resolve(import.meta.dir, "../../..");
const CORE_PKG = resolve(import.meta.dir, "../..");

const FORBIDDEN_EXPORTS = [
  "ownerPromote",
  "promote",
  "fileProposal",
  "listProposals",
  "initStaging",
  "openStagingDb",
  "setProposalStatus",
] as const;

interface Source {
  path: string;
  text: string;
}

function productionSources(): Source[] {
  const files: Source[] = [];
  for (const pkg of readdirSync(PACKAGES).sort()) {
    const root = join(PACKAGES, pkg, "src");
    let isDirectory = false;
    try {
      isDirectory = statSync(root).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) continue;
    for (const rel of sourceFiles(root)) {
      files.push({
        path: `${pkg}/src/${rel}`,
        text: readFileSync(join(root, rel), "utf8"),
      });
    }
  }
  return files;
}

describe("no-return owner-gate surfaces", () => {
  test("the published package map does not export ./staging", () => {
    const pkg = JSON.parse(readFileSync(join(CORE_PKG, "package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports).not.toHaveProperty("./staging");
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./contracts"]);
  });

  test("the public core surface does not export owner-gate write functions", () => {
    const keys = Object.keys(core);
    for (const name of FORBIDDEN_EXPORTS) {
      expect(keys).not.toContain(name);
    }
  });

  test("the internal staging barrel does not export a promote write path", () => {
    const keys = Object.keys(staging);
    expect(keys).not.toContain("ownerPromote");
    expect(keys).not.toContain("promote");
    expect(keys).not.toContain("PromoteError");
    expect(keys).not.toContain("readPromotion");
  });

  test("no production module imports the retired staging subpath", () => {
    const offenders = productionSources().filter(({ text }) =>
      /@kizuki\/core\/staging/.test(text),
    );
    expect(offenders.map(({ path }) => path)).toEqual([]);
  });

  test("no production module calls ownerPromote", () => {
    const offenders = productionSources().filter(({ text }) =>
      /\bownerPromote\s*\(/.test(text),
    );
    expect(offenders.map(({ path }) => path)).toEqual([]);
  });
});
