import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault, VaultInitError } from "../src/vault/init";

const roots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "kizuki-init-git-"));
  roots.push(root);
  git(root, ["init", "--quiet"]);
  return root;
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

function expectControlIgnored(root: string, prefix = ""): void {
  const paths = [".kizuki/.gitignore", ".kizuki/init.json", ".kizuki/connections/fixture.json"];
  for (const path of paths) {
    const relativePath = `${prefix}${path}`;
    expect(git(root, ["check-ignore", "--", relativePath]).trim()).toBe(relativePath);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("vault Git exclusion", () => {
  test("initializes a plain directory without a Git executable", () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-init-nongit-"));
    roots.push(root);
    const vault = join(root, "vault");
    const source = new URL("../src/vault/init.ts", import.meta.url).href;
    const script = `
      const { initVault } = await import(${JSON.stringify(source)});
      process.stdout.write(initVault(${JSON.stringify(vault)}).status);
    `;
    const result = Bun.spawnSync([process.execPath, "--eval", script], {
      cwd: root,
      env: { ...process.env, PATH: join(root, "no-executables") },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe("ready");
    expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe("/.kizuki/\n");
  });

  for (const [name, owner, expected] of [
    ["owner rules without a final newline", "# Owner rules\n*.log", "# Owner rules\n*.log\n/.kizuki/\n"],
    ["owner CRLF rules", "# Owner rules\r\n*.log\r\n", "# Owner rules\r\n*.log\r\n/.kizuki/\r\n"],
    ["an existing anchored exclusion", "/.kizuki/\n*.log\n", "/.kizuki/\n*.log\n"],
    ["an inclusion after an older exclusion", "/.kizuki/\n!*/\n", "/.kizuki/\n!*/\n/.kizuki/\n"],
  ] as const) {
    test(`preserves ${name} and keeps control files ignored on repeated init`, () => {
      const root = repository();
      writeFileSync(join(root, ".gitignore"), owner);
      initVault(root, { adopt: true });
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(expected);
      expectControlIgnored(root);

      const second = initVault(root);
      expect(second.repaired).not.toContain(".gitignore");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(expected);
      expectControlIgnored(root);
    });
  }

  test("repairs the root exclusion while preserving owner control-ignore entries", () => {
    const root = repository();
    initVault(root, { adopt: true });
    writeFileSync(join(root, ".gitignore"), "# Owner canon rules\n*.log\n");
    const controlIgnore = "# Owner control rules\n*.cache\n";
    writeFileSync(join(root, ".kizuki", ".gitignore"), controlIgnore);

    const result = initVault(root);
    expect(result.repaired).toContain(".gitignore");
    expect(readFileSync(join(root, ".kizuki", ".gitignore"), "utf8")).toBe(controlIgnore);
    expectControlIgnored(root);
  });

  test("adds the exclusion at a nested vault without changing its enclosing repository rules", () => {
    const root = repository();
    const ownerRules = "# Repository rules\n*.log\n";
    writeFileSync(join(root, ".gitignore"), ownerRules);
    const vault = join(root, "notes", "vault");
    initVault(vault);
    expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe("/.kizuki/\n");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(ownerRules);
    expectControlIgnored(root, "notes/vault/");
  });

  test("allows tracked owner files and preserves the index on successful adoption", () => {
    const root = repository();
    writeFileSync(join(root, "notes.md"), "# Synthetic owner note\n");
    git(root, ["add", "--", "notes.md"]);
    const index = readFileSync(join(root, ".git", "index"));
    expect(initVault(root, { adopt: true }).status).toBe("ready");
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
    expectControlIgnored(root);
  });

  test("recognizes the Git metadata file of a linked worktree", () => {
    const root = repository();
    git(root, ["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--quiet", "--allow-empty", "-m", "Initialize synthetic fixture"]);
    const linked = join(root, "linked");
    git(root, ["worktree", "add", "--quiet", "--detach", linked]);
    expect(initVault(linked, { adopt: true }).status).toBe("ready");
    expectControlIgnored(linked);
  });

  for (const prefix of ["", "notes/vault/"]) {
    test(`refuses already tracked control entries before writes (${prefix || "repository root"})`, () => {
      const root = repository();
      const vault = join(root, prefix);
      mkdirSync(join(vault, ".kizuki"), { recursive: true });
      const fixture = join(vault, ".kizuki", "fixture.txt");
      writeFileSync(fixture, "synthetic tracked fixture\n");
      git(root, ["add", "--", `${prefix}.kizuki/fixture.txt`]);
      const index = readFileSync(join(root, ".git", "index"));
      writeFileSync(join(vault, ".gitignore"), "# Owner rules\n");

      for (const dryRun of [false, true]) {
        let failure: unknown;
        try { initVault(vault, { adopt: true, dryRun }); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(VaultInitError);
        expect((failure as VaultInitError).code).toBe("tracked_control_state");
        expect((failure as Error).message).toContain("Git's index and history were not changed");
        expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
        expect(readFileSync(fixture, "utf8")).toBe("synthetic tracked fixture\n");
        expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe("# Owner rules\n");
        expect(existsSync(join(vault, "CANON.md"))).toBe(false);
        expect(existsSync(join(vault, ".kizuki", "init.json"))).toBe(false);
      }
    });
  }

  test("refuses unreadable Git metadata before creating a vault", () => {
    const root = repository();
    writeFileSync(join(root, ".git", "index"), "incomplete synthetic index\n");
    const index = readFileSync(join(root, ".git", "index"));
    const vault = join(root, "vault");
    let failure: unknown;
    try { initVault(vault); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(VaultInitError);
    expect((failure as VaultInitError).code).toBe("git_status_unavailable");
    expect(existsSync(vault)).toBe(false);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
  });
});
