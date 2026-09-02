import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import {
  GGUF_MODEL_CATALOG,
  fixtureSpaceId,
  installGgufModel,
  installPartialPath,
  sha256File,
  vaultModelsDir,
  writeFixtureGguf,
} from "../src/index";
import { temporaryEmbed, writeTempGguf } from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("local GGUF model install", () => {
  test("copies a local GGUF and reports sha256 without requiring a pin", () => {
    const temporary = temporaryEmbed();
    cleanups.push(temporary.cleanup);
    const destDir = vaultModelsDir(temporary.vault);
    const installed = installGgufModel({
      source_path: temporary.modelPath,
      dest_dir: destDir,
    });
    expect(installed.bytes).toBeGreaterThan(64);
    expect(installed.sha256).toBe(sha256File(temporary.modelPath));
    expect(installed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(installed.path).toBe(join(destDir, "model.gguf"));
    expect(installed.space.id).toBe(fixtureSpaceId());
    expect(GGUF_MODEL_CATALOG[0]?.id).toBe("kizuki-fixture-embed");
  });

  test("verifies sha256 when an expected digest is supplied", () => {
    const temporary = temporaryEmbed();
    cleanups.push(temporary.cleanup);
    const destDir = vaultModelsDir(temporary.vault);
    const digest = sha256File(temporary.modelPath);
    const installed = installGgufModel({
      source_path: temporary.modelPath,
      dest_dir: destDir,
      expected_sha256: digest,
    });
    expect(installed.sha256).toBe(digest);
  });

  test("hash mismatch and missing source fail closed without a download", () => {
    const temporary = temporaryEmbed();
    cleanups.push(temporary.cleanup);
    try {
      installGgufModel({
        source_path: temporary.modelPath,
        dest_dir: vaultModelsDir(temporary.vault),
        expected_sha256: "0".repeat(64),
      });
      throw new Error("expected hash mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("config_invalid");
    }

    try {
      installGgufModel({
        source_path: join(temporary.root, "absent.gguf"),
        dest_dir: vaultModelsDir(temporary.vault),
      });
      throw new Error("expected missing source");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("unavailable");
    }
  });

  test("refuses a relative source path", () => {
    const temporary = temporaryEmbed();
    cleanups.push(temporary.cleanup);
    mkdirSync(join(temporary.root, "rel"), { recursive: true });
    writeFileSync(join(temporary.root, "rel", "model.gguf"), writeFixtureGguf());
    try {
      installGgufModel({
        source_path: "rel/model.gguf",
        dest_dir: vaultModelsDir(temporary.vault),
      });
      throw new Error("expected relative path refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("config_invalid");
    }
  });

  test("each install gets a unique exclusive partial path", () => {
    const dest = "/tmp/kizuki-models/model.gguf";
    const first = installPartialPath(dest);
    const second = installPartialPath(dest);
    expect(first).not.toBe(second);
    expect(first).not.toBe(`${dest}.partial`);
    expect(second).not.toBe(`${dest}.partial`);
  });

  test("concurrent same-basename installs report their own source hash", async () => {
    const temporary = temporaryEmbed();
    cleanups.push(temporary.cleanup);
    const destDir = vaultModelsDir(temporary.vault);
    const alpha = writeTempGguf(join(temporary.root, "alpha"), {
      name: "alpha-embed",
    });
    const beta = writeTempGguf(join(temporary.root, "beta"), {
      name: "beta-embed",
    });
    const [alphaResult, betaResult] = await Promise.all([
      runInstallOnce(alpha, destDir),
      runInstallOnce(beta, destDir),
    ]);
    expect(alphaResult.exit).toBe(0);
    expect(betaResult.exit).toBe(0);
    expect(alphaResult.stderr).toBe("");
    expect(betaResult.stderr).toBe("");
    const alphaOut = JSON.parse(alphaResult.stdout) as {
      sha256: string;
      space: string;
    };
    const betaOut = JSON.parse(betaResult.stdout) as {
      sha256: string;
      space: string;
    };
    expect(alphaOut.sha256).toBe(sha256File(alpha));
    expect(betaOut.sha256).toBe(sha256File(beta));
    expect(alphaOut.sha256).not.toBe(betaOut.sha256);
    expect(alphaOut.space).toBe("gguf:alpha-embed@8");
    expect(betaOut.space).toBe("gguf:beta-embed@8");
    expect(
      readdirSync(destDir).filter((name) => name.endsWith(".partial")),
    ).toEqual([]);
  });
});

async function runInstallOnce(
  source: string,
  destDir: string,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "install-once.ts")],
    env: {
      ...process.env,
      KIZUKI_GGUF_SOURCE: source,
      KIZUKI_GGUF_DEST: destDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}
