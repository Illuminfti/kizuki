import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const mainPath = resolve(import.meta.dir, "../src/main.ts");
const temporaryDirectories: string[] = [];

interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function runCli(...args: string[]): CliResult {
  const result = Bun.spawnSync([process.execPath, mainPath, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("kizuki CLI", () => {
  test("ingests, stages, reviews, queries, and diagnoses a vault", () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-cli-"));
    temporaryDirectories.push(root);
    const fixture = join(root, "fixture");
    const vault = join(root, "vault");
    mkdirSync(fixture);
    writeFileSync(
      join(fixture, "alpha.md"),
      "A celestial-piano phrase unique to the promoted page.\n",
    );
    writeFileSync(
      join(fixture, "beta.md"),
      "A river-stone phrase unique to the rejected proposal.\n",
    );
    writeFileSync(
      join(fixture, "gamma.md"),
      "A moth-lantern phrase unique to the withdrawn proposal.\n",
    );

    expect(runCli("init", vault)).toMatchObject({ exitCode: 0 });

    const firstIngest = runCli(
      "ingest",
      "kizuki.markdown-folder",
      "--vault",
      vault,
      "--source",
      fixture,
    );
    expect(firstIngest).toMatchObject({
      exitCode: 0,
      stdout:
        "events_stored=3 duplicates=0 proposals_created=3 withdrawn=0 retractions_filed=0\n",
    });

    // The checkpoint stored by the first run makes the second an incremental
    // sync: an unchanged source emits nothing.
    const secondIngest = runCli(
      "ingest",
      "kizuki.markdown-folder",
      "--vault",
      vault,
      "--source",
      fixture,
    );
    expect(secondIngest).toMatchObject({
      exitCode: 0,
      stdout:
        "events_stored=0 duplicates=0 proposals_created=0 withdrawn=0 retractions_filed=0\n",
    });

    const proposals = runCli("proposals", "--vault", vault);
    expect(proposals.exitCode).toBe(0);
    const rows = proposals.stdout
      .trimEnd()
      .split("\n")
      .filter((line) => /^01[A-Z0-9]{24}\s/.test(line));
    expect(rows).toHaveLength(3);
    const promotedRow = rows.find((line) => line.includes("celestial-piano"));
    const rejectedRow = rows.find((line) => line.includes("river-stone"));
    expect(promotedRow).toBeDefined();
    expect(rejectedRow).toBeDefined();
    const promotedId = promotedRow?.split(/\s+/)[0];
    const rejectedId = rejectedRow?.split(/\s+/)[0];
    expect(promotedId).toBeDefined();
    expect(rejectedId).toBeDefined();
    if (promotedId === undefined || rejectedId === undefined) {
      throw new Error("proposal ids were not rendered");
    }

    const unsafePromotion = runCli("promote", promotedId, "--vault", vault);
    expect(unsafePromotion.exitCode).not.toBe(0);
    // A targetless capture promotes into captures/; nothing may exist there yet.
    expect(existsSync(join(vault, "captures"))).toBe(false);

    const promotion = runCli(
      "promote",
      promotedId,
      "--vault",
      vault,
      "--sensitivity",
      "personal",
    );
    expect(promotion.exitCode).toBe(0);
    const pagePath = promotion.stdout.match(/^page_path=(.+)$/m)?.[1];
    const receiptId = promotion.stdout.match(/^receipt_id=(.+)$/m)?.[1];
    expect(pagePath).toBeDefined();
    expect(receiptId).toMatch(/^01[A-Z0-9]{24}$/);
    if (pagePath === undefined) throw new Error("page path was not printed");
    expect(readFileSync(pagePath, "utf8")).toContain('sensitivity: "personal"');

    const query = runCli("query", "celestial-piano", "--vault", vault);
    expect(query.exitCode).toBe(0);
    expect(query.stdout).toMatch(/^page\s+\S+\s+\S+.*celestial-piano/m);

    const rejection = runCli(
      "reject",
      rejectedId,
      "--vault",
      vault,
      "--reason",
      "not canonical",
    );
    expect(rejection.exitCode).toBe(0);

    const doctor = runCli("doctor", "--vault", vault);
    expect(doctor).toMatchObject({ exitCode: 0 });
    expect(doctor.stdout).toContain("events=3");

    // Source deletions: gamma still has a pending proposal (withdrawn), alpha
    // was promoted (a deletion proposal reaches the review queue).
    rmSync(join(fixture, "alpha.md"));
    rmSync(join(fixture, "gamma.md"));
    const thirdIngest = runCli(
      "ingest",
      "kizuki.markdown-folder",
      "--vault",
      vault,
      "--source",
      fixture,
    );
    expect(thirdIngest).toMatchObject({
      exitCode: 0,
      stdout:
        "events_stored=2 duplicates=0 proposals_created=0 withdrawn=1 retractions_filed=1\n",
    });

    const doctorAfterDeletion = runCli("doctor", "--vault", vault);
    expect(doctorAfterDeletion.exitCode).toBe(0);
    expect(doctorAfterDeletion.stdout).toMatch(
      /^retraction-pending 01[A-Z0-9]{24} page=captures\/01[A-Z0-9]{24}\.md$/m,
    );

    const pendingAfterDeletion = runCli("proposals", "--vault", vault);
    expect(pendingAfterDeletion.exitCode).toBe(0);
    const retractionRow = pendingAfterDeletion.stdout
      .trimEnd()
      .split("\n")
      .find((line) => /^01[A-Z0-9]{24}\s+deletion\s/.test(line));
    expect(retractionRow).toBeDefined();
    const retractionId = retractionRow?.split(/\s+/)[0];
    if (retractionId === undefined) {
      throw new Error("retraction proposal id was not rendered");
    }

    const retraction = runCli(
      "promote",
      retractionId,
      "--vault",
      vault,
      "--sensitivity",
      "personal",
    );
    expect(retraction.exitCode).toBe(0);
    expect(readFileSync(pagePath, "utf8")).toContain('status: "archived"');

    // Neither the archived page nor the tombstoned record's events are served.
    const queryAfterRetraction = runCli(
      "query",
      "celestial-piano",
      "--vault",
      vault,
    );
    expect(queryAfterRetraction.exitCode).toBe(0);
    expect(queryAfterRetraction.stdout).toBe("");

    const finalDoctor = runCli("doctor", "--vault", vault);
    expect(finalDoctor).toMatchObject({ exitCode: 0 });
    expect(finalDoctor.stdout).not.toContain("retraction-pending");
  });
});
