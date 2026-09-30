import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
  setDefaultTimeout,
} from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { askEstate } from "../src/parity/estate";
import { compareSources, sourceHash } from "../src/parity/receipt";
import { parityExitCode, runParity } from "../src/parity/run";
import type { ParityReceipt } from "../src/parity/receipt";
import { createHelpers, fixtureConsent } from "./helpers";

// These tests spawn real CLI processes and fake estate stacks; bound them for a loaded host.
setDefaultTimeout(90_000);

const helpers = createHelpers();
const { runCli, tempDir, isolatedEnv } = helpers;
afterAll(helpers.cleanup);

const ESTATE = resolve(import.meta.dir, "fixtures/parity-estate.ts");
const SENTINEL_NAME = "Zorblatt Quimby";
const ESTATE_PRIVATE = "Vesper Quillfeather";
const QUERIES = [
  `${SENTINEL_NAME} lantern`,
  "river-stone kernel",
  "moth-lantern patch",
];

interface Seeded {
  env: Record<string, string | undefined>;
  root: string;
  vault: string;
  queriesFile: string;
  /** Source keys Kizuki itself returns for each query, learned through `context --json`. */
  kizukiKeys: string[][];
}

let seeded: Seeded;

function contextKeys(
  env: Record<string, string | undefined>,
  query: string,
): string[] {
  const result = runCli(
    env,
    "context",
    "--purpose",
    "recall",
    "--budget",
    "2000",
    "--query",
    query,
    "--json",
  );
  expect(result.exitCode, result.stderr).toBe(0);
  const body = JSON.parse(result.stdout) as {
    data: {
      canon: { path: string; sources: string[] }[];
      quoted: { event_id: string }[];
    };
  };
  return [
    ...body.data.canon.flatMap((chunk) => [chunk.path, ...chunk.sources]),
    ...body.data.quoted.map((chunk) => chunk.event_id),
  ];
}

beforeAll(() => {
  const setup = helpers.tempVault();
  const notes = join(setup.root, "parity-notes");
  mkdirSync(notes);
  writeFileSync(
    join(notes, "lantern.md"),
    `${SENTINEL_NAME} leads the lantern project.\n`,
  );
  writeFileSync(
    join(notes, "kernel.md"),
    "grace shipped the river-stone kernel.\n",
  );
  writeFileSync(
    join(notes, "patch.md"),
    "linus reviewed the moth-lantern patch.\n",
  );
  const imported = runCli(
    setup.env,
    "import",
    "markdown-folder",
    "--source",
    notes,
    ...fixtureConsent(setup.root),
  );
  expect(imported.exitCode, imported.stderr).toBe(0);
  const queriesFile = join(setup.root, "queries.txt");
  writeFileSync(queriesFile, `${QUERIES.join("\n")}\n`);
  const kizukiKeys = QUERIES.map((query) => contextKeys(setup.env, query));
  expect(kizukiKeys.every((keys) => keys.length > 0)).toBe(true);
  seeded = {
    env: setup.env,
    root: setup.root,
    vault: setup.vault,
    queriesFile,
    kizukiKeys,
  };
});

/** Fake stack that answers every query with the same key lines. */
function keysStack(lines: string[], extra: { log?: string } = {}): string[] {
  const file = join(tempDir("parity-keys-"), "keys.txt");
  writeFileSync(file, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  return [process.execPath, ESTATE, "keys", file, extra.log ?? "-"];
}

function run(
  estate: string[],
  options: string[] = [],
  queries = seeded.queriesFile,
) {
  return runCli(
    seeded.env,
    "parity",
    "run",
    "--queries",
    queries,
    ...options,
    "--estate-cmd",
    "--",
    ...estate,
  );
}

interface Receipt {
  schema: string;
  run_id: string;
  config: Record<string, unknown>;
  queries: {
    index: number;
    query_hash: string;
    kizuki: {
      status: string;
      error_class: string | null;
      latency_ms: number;
      count: number;
    };
    estate: {
      status: string;
      error_class: string | null;
      exit_code: number | null;
      latency_ms: number;
      count: number;
    };
    overlap: {
      comparable: boolean;
      shared: number;
      estate_count: number;
      kizuki_count: number;
      ratio: number | null;
      kizuki_only: string[];
      estate_only: string[];
    };
  }[];
  summary: {
    queries: number;
    compared: number;
    mean_overlap: number | null;
    verdict: string;
    kizuki_failures: number;
    estate_failures: number;
    estate_empty: number;
    coverage: number;
    exit_code: number;
  };
}

function receiptOf(result: { stdout: string }): {
  receipt: Receipt;
  file: string;
  text: string;
} {
  const body = JSON.parse(result.stdout) as { data: { receipt: string } };
  const file = join(seeded.vault, body.data.receipt);
  const text = readFileSync(file, "utf8");
  return { receipt: JSON.parse(text) as Receipt, file, text };
}

function digest(bytes: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Every ledger table except the owner-read audit trail, plus canon files and the canon receipt log. */
function observeState(vault: string): string {
  const observer = tempDir("parity-observer-");
  for (const name of ["kizuki.db", "kizuki.db-wal", "kizuki.db-shm"]) {
    const path = join(vault, ".kizuki", name);
    if (existsSync(path)) copyFileSync(path, join(observer, name));
  }
  const db = new Database(join(observer, "kizuki.db"), {
    readwrite: true,
    create: false,
  });
  const parts: string[] = [];
  try {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    for (const { name } of tables) {
      if (name === "agent_audit") continue;
      try {
        parts.push(
          `${name}:${digest(JSON.stringify(db.query(`SELECT * FROM "${name}"`).all()))}`,
        );
      } catch {
        parts.push(`${name}:unreadable`);
      }
    }
  } finally {
    db.close();
  }
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (directory === vault && entry === ".kizuki") continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else
        parts.push(`${path.slice(vault.length)}:${digest(readFileSync(path))}`);
    }
  };
  walk(vault);
  const promotions = join(vault, ".kizuki", "receipts", "promotions.jsonl");
  parts.push(
    `promotions:${existsSync(promotions) ? digest(readFileSync(promotions)) : "none"}`,
  );
  return digest(parts.join("\n"));
}

describe("parity run: usage", () => {
  test("help and the root listing name the verb", () => {
    const env = isolatedEnv();
    expect(runCli(env, "help", "parity").stdout).toContain(
      "usage: kizuki parity run --queries FILE",
    );
    expect(runCli(env, "--help").stdout).toContain("parity");
  });

  test("usage errors exit 2 before any vault is opened", () => {
    const env = isolatedEnv();
    const dir = tempDir("parity-usage-");
    const good = join(dir, "queries.txt");
    writeFileSync(good, "one query\n");
    const control = join(dir, "control.txt");
    writeFileSync(control, "bad\u001bquery\n");
    const long = join(dir, "long.txt");
    writeFileSync(long, `${"q".repeat(513)}\n`);
    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "\n# only a comment\n");
    const many = join(dir, "many.txt");
    writeFileSync(
      many,
      `${Array.from({ length: 201 }, (_, index) => `query ${index}`).join("\n")}\n`,
    );
    const stack = [process.execPath, ESTATE, "keys", "-", "-"];
    const cases: string[][] = [
      ["parity"],
      ["parity", "compare"],
      ["parity", "run", "--estate-cmd", "--", ...stack],
      ["parity", "run", "--queries", good],
      ["parity", "run", "--queries", good, "--estate-cmd"],
      [
        "parity",
        "run",
        "--queries",
        join(dir, "missing.txt"),
        "--estate-cmd",
        "--",
        ...stack,
      ],
      ["parity", "run", "--queries", dir, "--estate-cmd", "--", ...stack],
      ["parity", "run", "--queries", control, "--estate-cmd", "--", ...stack],
      ["parity", "run", "--queries", long, "--estate-cmd", "--", ...stack],
      ["parity", "run", "--queries", empty, "--estate-cmd", "--", ...stack],
      ["parity", "run", "--queries", many, "--estate-cmd", "--", ...stack],
      [
        "parity",
        "run",
        "--queries",
        good,
        "--k",
        "0",
        "--estate-cmd",
        "--",
        ...stack,
      ],
      [
        "parity",
        "run",
        "--queries",
        good,
        "--k",
        "21",
        "--estate-cmd",
        "--",
        ...stack,
      ],
      [
        "parity",
        "run",
        "--queries",
        good,
        "--timeout-ms",
        "10",
        "--estate-cmd",
        "--",
        ...stack,
      ],
      [
        "parity",
        "run",
        "--queries",
        good,
        "--min-overlap",
        "1.5",
        "--estate-cmd",
        "--",
        ...stack,
      ],
      [
        "parity",
        "run",
        "--queries",
        good,
        "--min-overlap",
        "half",
        "--estate-cmd",
        "--",
        ...stack,
      ],
      [
        "parity",
        "run",
        "--queries",
        good,
        "--bogus",
        "1",
        "--estate-cmd",
        "--",
        ...stack,
      ],
    ];
    for (const args of cases) {
      const result = runCli(env, ...args);
      expect(result.exitCode, args.join(" ")).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "usage: kizuki parity run --queries FILE",
      );
      expect(result.stderr).not.toContain("no vault configured");
    }
  });
});

describe("parity run: two fake stacks", () => {
  test("a stack that mirrors Kizuki meets the threshold and records only hashed diffs", () => {
    const mirrored = seeded.kizukiKeys[0]!;
    const result = run(keysStack(mirrored), ["--json", "--k", "5"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const { receipt } = receiptOf(result);
    expect(receipt.schema).toBe("kizuki.parity-receipt/v1");
    expect(receipt.queries).toHaveLength(QUERIES.length);
    const first = receipt.queries[0]!;
    expect(first.overlap).toMatchObject({
      comparable: true,
      shared: mirrored.length,
      estate_only: [],
    });
    expect(first.overlap.ratio).toBe(1);
    expect(first.kizuki.status).toBe("ok");
    expect(first.estate).toMatchObject({
      status: "ok",
      error_class: null,
      exit_code: 0,
    });
    expect(first.query_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(receipt.queries.map((entry) => entry.query_hash)).size).toBe(
      QUERIES.length,
    );
    expect(receipt.summary.exit_code).toBe(0);
  });

  test("an unrelated stack falls below the threshold and the diff is hashed and bounded", () => {
    const unrelated = Array.from(
      { length: 8 },
      (_, index) => `unrelated/${SENTINEL_NAME.replace(" ", "-")}-${index}.md`,
    );
    const result = run(keysStack(unrelated), ["--json", "--k", "3"]);
    expect(result.exitCode, result.stderr).toBe(4);
    const { receipt, text } = receiptOf(result);
    expect(receipt.summary).toMatchObject({
      compared: QUERIES.length,
      mean_overlap: 0,
      verdict: "below_threshold",
      exit_code: 4,
    });
    for (const entry of receipt.queries) {
      expect(entry.estate.count).toBe(3);
      expect(entry.overlap.estate_only).toHaveLength(3);
      expect(entry.overlap.kizuki_only.length).toBeLessThanOrEqual(3);
      for (const hash of [
        ...entry.overlap.estate_only,
        ...entry.overlap.kizuki_only,
      ])
        expect(hash).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(text).not.toContain("unrelated/");
  });

  test("partial overlap is scored per query and --min-overlap decides the exit code", () => {
    const [own] = seeded.kizukiKeys;
    const half = [own![0]!, "elsewhere/one.md"];
    const strict = run(keysStack(half), ["--json", "--min-overlap", "0.9"]);
    expect(strict.exitCode, strict.stderr).toBe(4);
    const lenient = run(keysStack(half), ["--json", "--min-overlap", "0.05"]);
    expect(lenient.exitCode, lenient.stderr).toBe(0);
    const { receipt } = receiptOf(lenient);
    expect(receipt.queries[0]!.overlap).toMatchObject({
      shared: 1,
      estate_count: 2,
      ratio: 0.5,
    });
    expect(receipt.summary.verdict).toBe("met");
  });

  test("a stack with no results is not measured and never passes", () => {
    const result = run(keysStack([]), ["--json"]);
    expect(result.exitCode, result.stderr).toBe(4);
    const { receipt } = receiptOf(result);
    expect(receipt.summary).toMatchObject({
      compared: 0,
      mean_overlap: null,
      verdict: "not_measured",
    });
    expect(
      receipt.queries.every(
        (entry) => !entry.overlap.comparable && entry.overlap.ratio === null,
      ),
    ).toBe(true);
  });

  test("the query reaches the stack by placeholder or as the final argument", () => {
    const log = join(tempDir("parity-log-"), "queries.log");
    const stack = keysStack(seeded.kizukiKeys[0]!, { log });
    expect(run(stack, ["--json"]).exitCode).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(QUERIES);
    const placed = join(tempDir("parity-log-"), "placed.log");
    const withPlaceholder = [
      process.execPath,
      ESTATE,
      "keys",
      "-",
      placed,
      "--query={query}",
      "{query}",
    ];
    run(withPlaceholder, ["--json"]);
    expect(readFileSync(placed, "utf8").trim().split("\n")).toEqual(QUERIES);
  });

  test("replacement characters in a query reach the stack unchanged", () => {
    const queries = join(tempDir("parity-special-"), "queries.txt");
    writeFileSync(queries, "cost $& then $1 and $$ done\n");
    const log = join(tempDir("parity-log-"), "special.log");
    const stack = [process.execPath, ESTATE, "keys", "-", log, "{query}"];
    expect(run(stack, ["--json"], queries).exitCode).toBe(4);
    expect(readFileSync(log, "utf8")).toBe("cost $& then $1 and $$ done\n");
  });
});

describe("parity run: honesty and bounds", () => {
  test("receipts, stdout and stderr hold no query text, result text or personal names", () => {
    const leaky = [`people/${SENTINEL_NAME.replace(" ", "-")}.md`, ...seeded.kizukiKeys[0]!];
    const stack = keysStack(leaky);
    const json = run(stack, ["--json"]);
    const text = run(stack, []);
    expect([json.exitCode, text.exitCode]).toEqual([0, 0]);
    const surfaces = [receiptOf(json).text, json.stdout, json.stderr, text.stdout, text.stderr];
    for (const surface of surfaces) {
      expect(surface).not.toContain("Zorblatt");
      expect(surface).not.toContain("lantern");
      expect(surface).not.toContain("river-stone");
      expect(surface).not.toContain("KIZUKI CONTEXT");
      for (const key of leaky) expect(surface).not.toContain(key);
    }
  });

  test("a run never writes canon or ledger state and injects no context", () => {
    const before = observeState(seeded.vault);
    const result = run(keysStack(seeded.kizukiKeys[1]!), ["--json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(observeState(seeded.vault)).toBe(before);
    const { file } = receiptOf(result);
    expect(file).toContain(join(".kizuki", "receipts", "parity"));
    expect(result.stdout).not.toContain("packet_md");
  });

  test("a failing stack is recorded, not fatal, and its output never leaks", () => {
    const queries = join(tempDir("parity-mixed-"), "queries.txt");
    writeFileSync(queries, `${QUERIES[0]}\nboom query\n${QUERIES[1]}\n`);
    const keysFile = join(tempDir("parity-keys-"), "keys.txt");
    writeFileSync(keysFile, `${seeded.kizukiKeys[0]!.join("\n")}\n`);
    const result = run(
      [process.execPath, ESTATE, "keys-unless-boom", keysFile, "-"],
      ["--json"],
      queries,
    );
    expect(result.exitCode, result.stderr).toBe(3);
    const { receipt, text } = receiptOf(result);
    expect(receipt.queries).toHaveLength(3);
    expect(receipt.queries[1]!.estate).toMatchObject({
      status: "error",
      error_class: "nonzero_exit",
      exit_code: 7,
    });
    expect(receipt.queries[1]!.overlap.comparable).toBe(false);
    expect(receipt.queries[0]!.estate.status).toBe("ok");
    expect(receipt.queries[2]!.estate.status).toBe("ok");
    expect(receipt.summary).toMatchObject({ estate_failures: 1, exit_code: 3 });
    for (const surface of [text, result.stdout, result.stderr]) {
      expect(surface).not.toContain(ESTATE_PRIVATE);
      expect(surface).not.toContain("boom");
    }
  });

  test("a hung stack is cut off at the per-query timeout", () => {
    const started = Date.now();
    const result = run(
      [process.execPath, ESTATE, "hang", "-", "-"],
      ["--json", "--timeout-ms", "500"],
    );
    expect(result.exitCode, result.stderr).toBe(3);
    expect(Date.now() - started).toBeLessThan(45_000);
    const { receipt } = receiptOf(result);
    expect(receipt.queries.map((entry) => entry.estate.error_class)).toEqual([
      "timeout",
      "timeout",
      "timeout",
    ]);
  });

  test("a stack that cannot start is a recorded external failure", () => {
    const result = run(
      [join(seeded.root, "no-such-stack"), "--flag"],
      ["--json"],
    );
    expect(result.exitCode, result.stderr).toBe(3);
    const { receipt } = receiptOf(result);
    expect(
      receipt.queries.every(
        (entry) => entry.estate.error_class === "spawn_failed",
      ),
    ).toBe(true);
    expect(receipt.queries.every((entry) => entry.kizuki.status === "ok")).toBe(
      true,
    );
  });

  test("a stack that floods stdout is stopped at the output bound", () => {
    const result = run(
      [process.execPath, ESTATE, "flood", "-", "-"],
      ["--json", "--timeout-ms", "20000"],
    );
    expect(result.exitCode, result.stderr).toBe(3);
    const { receipt, text } = receiptOf(result);
    expect(
      receipt.queries.every(
        (entry) => entry.estate.error_class === "output_too_large",
      ),
    ).toBe(true);
    expect(text.length).toBeLessThan(100_000);
  });

  test("text output summarises without echoing queries and names the receipt", () => {
    const result = run(keysStack(seeded.kizukiKeys[2]!), []);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /^parity run=\S+ queries=3 compared=\d+ estate_empty=\d+ mean_overlap=\S+ verdict=\S+/,
    );
    expect(result.stdout).toContain(join(".kizuki", "receipts", "parity"));
    expect(
      readdirSync(join(seeded.vault, ".kizuki", "receipts", "parity")).length,
    ).toBeGreaterThan(0);
  });

  test("without a configured vault the run fails as a runtime error, not a parity result", () => {
    const result = runCli(
      isolatedEnv(),
      "parity",
      "run",
      "--queries",
      seeded.queriesFile,
      "--estate-cmd",
      "--",
      ...keysStack(["a"]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no vault configured");
  });
});

describe("parity run: coverage, exit precedence, process group, digests", () => {
  test("a stack that answers under half the queries is not measured, and the gap is counted", () => {
    const keysFile = join(tempDir("parity-keys-"), "keys.txt");
    writeFileSync(keysFile, `${seeded.kizukiKeys[1]!.join("\n")}\n`);
    const result = run(
      [process.execPath, ESTATE, "keys-if-river", keysFile, "-"],
      ["--json", "--min-overlap", "0"],
    );
    expect(result.exitCode, result.stderr).toBe(4);
    const { receipt } = receiptOf(result);
    expect(receipt.summary).toMatchObject({
      queries: 3,
      compared: 1,
      estate_empty: 2,
      verdict: "not_measured",
    });
    expect(receipt.summary.mean_overlap).toBe(1);
    expect(result.stderr).toContain("1 of 3 queries were comparable");
  });

  test("a timed-out stack takes its whole process group with it", async () => {
    const pidFile = join(tempDir("parity-orphan-"), "pid");
    const answer = await askEstate(
      [process.execPath, ESTATE, "orphan", pidFile, "-"],
      "any query",
      { timeoutMs: 1_500, k: 5 },
    );
    expect(answer.error?.class).toBe("timeout");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let wait = 0; wait < 50 && alive(); wait += 1) await Bun.sleep(100);
    expect(alive()).toBe(false);
  });

  test("exit codes rank a Kizuki failure over a stack failure over a parity miss", () => {
    const base = { queries: 3, compared: 3, estate_empty: 0, coverage: 1, mean_overlap: 1 };
    const summary = (
      over: Partial<Omit<ParityReceipt["summary"], "exit_code">>,
    ): Omit<ParityReceipt["summary"], "exit_code"> => ({
      ...base,
      verdict: "met",
      kizuki_failures: 0,
      estate_failures: 0,
      ...over,
    });
    expect(parityExitCode(summary({}))).toBe(0);
    expect(parityExitCode(summary({ verdict: "below_threshold" }))).toBe(4);
    expect(parityExitCode(summary({ verdict: "not_measured" }))).toBe(4);
    expect(parityExitCode(summary({ verdict: "below_threshold", estate_failures: 1 }))).toBe(3);
    expect(
      parityExitCode(summary({ verdict: "below_threshold", estate_failures: 1, kizuki_failures: 1 })),
    ).toBe(1);
  });

  test("a Kizuki-side failure is recorded per query and exits 1", async () => {
    const keysFile = join(tempDir("parity-keys-"), "keys.txt");
    writeFileSync(keysFile, "a.md\n");
    const receipt = await runParity(
      {
        queries: ["one", "two"],
        estate: [process.execPath, ESTATE, "keys", keysFile, "-"],
        k: 5,
        timeoutMs: 5_000,
        minOverlap: 0.5,
      },
      async (query) =>
        query === "one"
          ? { ok: false, errorClass: "context_incomplete" }
          : { ok: true, chunks: [["a.md"]], degraded: [] },
    );
    expect(receipt.queries[0]!.kizuki).toMatchObject({
      status: "error",
      error_class: "context_incomplete",
      count: 0,
    });
    expect(receipt.queries[0]!.overlap.comparable).toBe(false);
    expect(receipt.summary).toMatchObject({ kizuki_failures: 1, compared: 1, exit_code: 1 });
  });

  test("a chunk with no usable key is not reported as a source, and duplicates collapse", () => {
    const overlap = compareSources([[], [], ["x.md"], ["x.md"]], ["y.md"], true);
    expect(overlap.kizuki_only).toEqual([sourceHash("x.md")]);
  });

  test("source digests are unsalted: a known page path is confirmable from the receipt", () => {
    const result = run(keysStack(["people/ada-lovelace.md"]), ["--json"]);
    const { text } = receiptOf(result);
    const known = digest("kizuki.parity/v1:source\0people/ada-lovelace.md").slice(0, 16);
    expect(text).toContain(known);
    expect(text).not.toContain("ada-lovelace");
  });
});
