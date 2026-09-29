import { parseTrackedTextRecords } from "./verify-tracked-text";

/** Coarse git grep -E prefilter; machinePathViolations does the precise match. */
export const MACHINE_PATH_PREFILTER = "/home/|/Users/|/data/|[A-Za-z]:\\\\Users\\\\";

/** Home directory names that fixtures and docs use as obviously synthetic people. */
export const SYNTHETIC_HOME_NAMES: ReadonlySet<string> = new Set([
  "ada", "alice", "bob", "example", "me", "name", "owner", "stranger", "test", "user", "username", "you",
]);

// A path root only counts at a path start: `archive/data/x` and `~/home/x` are relative.
const HOME_PATH = /(?<![\w./~$-])(?:\/home|\/Users)\/([A-Za-z0-9._-]+)/gu;
const WINDOWS_HOME_PATH = /(?<![\w])[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)/gu;
const DATA_PATH = /(?<![\w./~$-])\/data\/[A-Za-z0-9._-]+/gu;

/** The machine-specific absolute path fragments in one line of tracked text. */
export function machinePathsIn(text: string): string[] {
  const found: string[] = [];
  for (const pattern of [HOME_PATH, WINDOWS_HOME_PATH]) {
    for (const match of text.matchAll(pattern)) {
      if (!SYNTHETIC_HOME_NAMES.has(match[1]!.toLowerCase())) found.push(match[0]);
    }
  }
  for (const match of text.matchAll(DATA_PATH)) found.push(match[0]);
  return found;
}

/** Failure lines for git grep -n -z records. The offending path text is never echoed. */
export function machinePathViolations(records: string): string[] {
  return parseTrackedTextRecords(records)
    .filter(({ text }) => machinePathsIn(text).length > 0)
    .map(({ path, line }) => `${JSON.stringify(path)}:${line}: machine-specific absolute path`);
}

if (import.meta.main && process.argv[2] === "--prefilter") {
  console.log(MACHINE_PATH_PREFILTER);
} else if (import.meta.main) {
  try {
    const failures = machinePathViolations(await Bun.stdin.text());
    if (failures.length > 0) {
      console.error(
        `verification failed: machine-specific absolute home or data path in tracked text\n${failures.join("\n")}\n` +
        "Use a placeholder such as <vault> or a synthetic name from SYNTHETIC_HOME_NAMES in scripts/verify-machine-paths.ts.",
      );
      process.exitCode = 1;
    }
  } catch {
    console.error("verification failed: machine-path validator could not read producer records");
    process.exitCode = 2;
  }
}
