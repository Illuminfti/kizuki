import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanCommitMessageText,
  scanSecretText,
  scanTrackedSecrets,
} from "./verify-secrets";

describe("secret verification", () => {
  test("detects high-confidence secret patterns without echoing them", () => {
    const aws = `AKIA${"A".repeat(16)}`;
    const pem = `-----BEGIN ${"RSA PRIVATE KEY"}-----`;
    const pat = `ghp_${"a".repeat(36)}`;
    const text = `config token=${aws}\n${pem}\ntoken=${pat}\n`;
    const findings = scanSecretText("packages/example.ts", text);
    expect(findings.map((finding) => finding.rule)).toEqual([
      "aws-access-key",
      "pem-private-key",
      "github-pat",
    ]);
    expect(findings.every((finding) => finding.path === "packages/example.ts")).toBe(
      true,
    );
    const serialized = JSON.stringify(findings);
    expect(serialized.includes(aws)).toBe(false);
    expect(serialized.includes(pem)).toBe(false);
    expect(serialized.includes(pat)).toBe(false);
  });

  test("ignores incomplete lookalikes from documentation", () => {
    const text = [
      "secret: any string matching /^(sk-|ghp_|xox[abp]-|AKIA)/",
      "example env: FILE_PRIVATE_KEY_PATH",
    ].join("\n");
    expect(scanSecretText("docs/example.md", text)).toEqual([]);
  });

  test("commit-message scan reports the commit, not the secret", () => {
    const aws = `AKIA${"B".repeat(16)}`;
    const findings = scanCommitMessageText("abc1234deadbeef", `chore: token ${aws}\n`);
    expect(findings).toEqual([
      expect.objectContaining({
        path: "commit abc1234deadbeef",
        rule: "aws-access-key",
      }),
    ]);
    expect(JSON.stringify(findings).includes(aws)).toBe(false);
  });

  test("the tracked tree contains no secret-pattern hits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kizuki-secrets-"));
    await writeFile(join(dir, "clean.txt"), "no credentials here\n");
    expect(scanSecretText("clean.txt", await Bun.file(join(dir, "clean.txt")).text()))
      .toEqual([]);
    expect(await scanTrackedSecrets()).toEqual([]);
  });
});
