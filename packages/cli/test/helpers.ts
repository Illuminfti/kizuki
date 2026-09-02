import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const mainPath = resolve(import.meta.dir, "../src/main.ts");

export interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface CliHelpers {
  cleanup(): void;
  isolatedEnv(
    overrides?: Record<string, string | undefined>,
  ): Record<string, string | undefined>;
  runCli(env: Record<string, string | undefined>, ...args: string[]): CliResult;
  tempDir(prefix?: string): string;
  tempVault(): {
    env: Record<string, string | undefined>;
    notes: string;
    root: string;
    vault: string;
  };
  writeNotes(directory: string): { ada: string; grace: string; linus: string };
}

export function createHelpers(): CliHelpers {
  const directories: string[] = [];

  const tempDir = (prefix = "kizuki-cli-"): string => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  };

  const isolatedEnv = (
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> => {
    const root = tempDir();
    return {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg"),
      KIZUKI_CONFIG: join(root, "config.toml"),
      ...overrides,
    };
  };

  const runCli = (
    env: Record<string, string | undefined>,
    ...args: string[]
  ): CliResult => {
    const home = env.HOME ?? tempDir("kizuki-home-");
    const spawnEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        key !== "KIZUKI_CONFIG" &&
        key !== "KIZUKI_VAULT" &&
        key !== "XDG_CONFIG_HOME"
      ) {
        spawnEnv[key] = value;
      }
    }
    spawnEnv.HOME = home;
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) spawnEnv[key] = value;
    }

    const result = Bun.spawnSync([process.execPath, mainPath, ...args], {
      env: spawnEnv,
      stderr: "pipe",
      stdout: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
    };
  };

  const writeNotes = (
    directory: string,
  ): { ada: string; grace: string; linus: string } => {
    mkdirSync(directory, { recursive: true });
    const ada = join(directory, "ada.md");
    const grace = join(directory, "grace.md");
    const linus = join(directory, "linus.md");
    writeFileSync(ada, "ada met grace at the acme library\n");
    writeFileSync(grace, "grace shipped the river-stone kernel\n");
    writeFileSync(linus, "linus reviewed the moth-lantern patch\n");
    return { ada, grace, linus };
  };

  const tempVault = (): {
    env: Record<string, string | undefined>;
    notes: string;
    root: string;
    vault: string;
  } => {
    const root = tempDir();
    const vault = join(root, "vault");
    const notes = join(root, "notes");
    const env = isolatedEnv({
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg"),
      KIZUKI_CONFIG: join(root, "config.toml"),
    });
    writeNotes(notes);
    const init = runCli(env, "init", vault);
    if (init.exitCode !== 0) {
      throw new Error(`tempVault init failed: ${init.stderr}`);
    }
    return { env, notes, root, vault };
  };

  return {
    cleanup() {
      for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    isolatedEnv,
    runCli,
    tempDir,
    tempVault,
    writeNotes,
  };
}
