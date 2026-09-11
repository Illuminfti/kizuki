import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFixtureGguf } from "@kizuki/embed-gguf";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli, runCliAsync, tempDir, tempVault } = createHelpers();
afterEach(cleanup);

describe("kizuki models pull", () => {
  test("copies a local GGUF into the vault models directory", () => {
    const setup = tempVault();
    const source = join(setup.root, "fixture.gguf");
    const bytes = writeFixtureGguf();
    writeFileSync(source, bytes);

    const result = runCli(setup.env, "models", "pull", "--from", source);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`path=${setup.vault}/.kizuki/models/fixture.gguf`);
    expect(result.stdout).toContain("bytes=");
    expect(result.stdout).toContain("sha256=");
    expect(result.stdout).toContain("space=gguf:kizuki-fixture-embed@8");
    expect(existsSync(join(setup.vault, ".kizuki", "models", "fixture.gguf"))).toBe(
      true,
    );
    expect(
      readFileSync(join(setup.vault, ".kizuki", "models", "fixture.gguf")),
    ).toEqual(Buffer.from(bytes));
  });

  test("without --from refuses to download and exits 2", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "models", "pull");
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("does not download weights");
    expect(result.stderr).toContain("usage: kizuki models");
  });

  test("unknown models verb exits 2", () => {
    const result = runCli(isolatedEnv(), "models", "fetch");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: kizuki models");
  });

  test("matching --sha256 copies and reports the digest", () => {
    const setup = tempVault();
    const source = join(setup.root, "fixture.gguf");
    const bytes = writeFixtureGguf();
    writeFileSync(source, bytes);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

    const result = runCli(
      setup.env,
      "models",
      "pull",
      "--from",
      source,
      "--sha256",
      digest,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`sha256=${digest}`);
    expect(existsSync(join(setup.vault, ".kizuki", "models", "fixture.gguf"))).toBe(
      true,
    );
  });

  test("hash mismatch fails closed", () => {
    const setup = tempVault();
    const source = join(tempDir(), "fixture.gguf");
    writeFileSync(source, writeFixtureGguf());
    const result = runCli(
      setup.env,
      "models",
      "pull",
      "--from",
      source,
      "--sha256",
      "0".repeat(64),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not match expected sha256");
  });

  test("matching --bytes copies and reports the size", () => {
    const setup = tempVault();
    const source = join(setup.root, "fixture.gguf");
    const bytes = writeFixtureGguf();
    writeFileSync(source, bytes);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

    const result = runCli(
      setup.env,
      "models",
      "pull",
      "--from",
      source,
      "--sha256",
      digest,
      "--bytes",
      String(bytes.byteLength),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`bytes=${bytes.byteLength}`);
    expect(result.stdout).toContain(`sha256=${digest}`);
  });

  test("size mismatch fails closed without replacing the destination", () => {
    const setup = tempVault();
    const source = join(setup.root, "fixture.gguf");
    const bytes = writeFixtureGguf();
    writeFileSync(source, bytes);
    const first = runCli(setup.env, "models", "pull", "--from", source);
    expect(first.exitCode).toBe(0);
    const dest = join(setup.vault, ".kizuki", "models", "fixture.gguf");
    const before = readFileSync(dest);

    const result = runCli(
      setup.env,
      "models",
      "pull",
      "--from",
      source,
      "--bytes",
      String(bytes.byteLength + 1),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not match expected bytes");
    expect(readFileSync(dest)).toEqual(before);
  });

  test("invalid --bytes exits 2", () => {
    const setup = tempVault();
    const source = join(setup.root, "fixture.gguf");
    writeFileSync(source, writeFixtureGguf());
    for (const value of ["0", "-1", "1.5", "foo"]) {
      const result = runCli(setup.env, "models", "pull", "--from", source, "--bytes", value);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage: kizuki models");
    }
  });

  test("a URL without --sha256 and --bytes refuses to download and exits 2", () => {
    const setup = tempVault();
    const result = runCli(
      setup.env,
      "models",
      "pull",
      "--from",
      "https://example.invalid/fixture.gguf",
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires --sha256 and --bytes");
    expect(result.stderr).toContain("does not download weights");
  });

  test("a URL with --sha256 and --bytes copies a synthetic fixture", async () => {
    const setup = tempVault();
    const bytes = writeFixtureGguf();
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(Buffer.from(bytes), {
          headers: { "content-type": "application/octet-stream" },
        });
      },
    });
    try {
      const result = await runCliAsync(
        setup.env,
        "models",
        "pull",
        "--from",
        new URL("/fixture.gguf", server.url).href,
        "--sha256",
        digest,
        "--bytes",
        String(bytes.byteLength),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`path=${setup.vault}/.kizuki/models/fixture.gguf`);
      expect(result.stdout).toContain(`sha256=${digest}`);
      expect(existsSync(join(setup.vault, ".kizuki", "models", "fixture.gguf"))).toBe(
        true,
      );
    } finally {
      await server.stop(true);
    }
  });
});

describe("kizuki models list and remove", () => {
  test("lists an installed fixture and removes only that file", () => {
    const setup = tempVault();
    const source = join(setup.root, "fixture.gguf");
    const bytes = writeFixtureGguf();
    writeFileSync(source, bytes);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(runCli(setup.env, "models", "pull", "--from", source).exitCode).toBe(0);

    const listed = runCli(setup.env, "models", "list");
    expect(listed.exitCode).toBe(0);
    expect(listed.stderr).toBe("");
    expect(listed.stdout).toContain("filename=fixture.gguf");
    expect(listed.stdout).toContain(`bytes=${bytes.byteLength}`);
    expect(listed.stdout).toContain(`sha256=${digest}`);

    const sibling = join(setup.root, "sentinel.txt");
    writeFileSync(sibling, "keep");
    const removed = runCli(setup.env, "models", "remove", "fixture.gguf");
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain(`removed=${setup.vault}/.kizuki/models/fixture.gguf`);
    expect(existsSync(join(setup.vault, ".kizuki", "models", "fixture.gguf"))).toBe(false);
    expect(readFileSync(sibling, "utf8")).toBe("keep");

    const empty = runCli(setup.env, "models", "list");
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toBe("");
  });

  test("refuses traversal, extra arguments, and unknown names", () => {
    const setup = tempVault();
    const missing = runCli(setup.env, "models", "remove", "missing.gguf");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("GGUF model is missing");

    const traversal = runCli(setup.env, "models", "remove", "../fixture.gguf");
    expect(traversal.exitCode).toBe(1);
    expect(traversal.stderr).toContain("exact installed filename");

    expect(runCli(setup.env, "models", "list", "extra").exitCode).toBe(2);
    expect(runCli(setup.env, "models", "remove").exitCode).toBe(2);
  });
});
