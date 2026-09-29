import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMachineOriginPath } from "../../src/canon/origin";
import { undoReceipt } from "../../src/canon/undo";
import { openLedger } from "../../src/ledger/db";
import { advanceExtractCheckpoint } from "../../src/serve/extract-checkpoint";
import { runRail } from "../../src/serve/rails";
import { getRunReceipt, persistRunReceipt } from "../../src/serve/receipts";
import { emptyRunTotals } from "../../src/serve/types";
import { doctorVault } from "../../src/vault/doctor";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { initVault } from "../../src/vault/init";
import { validatePage } from "../../src/vault/schema";
import { putEvent } from "../claims/helpers";
import { storeClaim, write } from "../canon/helpers";

// Each canon write fsyncs; bound the many-page test for a loaded host.
setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-brief-"));
  roots.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  let clock = "2026-09-28T12:00:00.000Z";
  const io = { db, vault_path: vault, now: () => clock };
  const runBrief = async (at: string, modelRef: string | null = null) => {
    const receipt = await runRail(db, vault, "brief", {
      now: () => at,
      hooks: { model_ref: modelRef },
    });
    const path = join(vault, "dashboards", `brief-${at.slice(0, 10)}.md`);
    return { receipt, path, text: readFileSync(path, "utf8") };
  };
  return {
    vault,
    db,
    io,
    runBrief,
    at: (value: string) => {
      clock = value;
    },
  };
}

const LOOSE = {
  subject: null,
  subjects: [] as string[],
  predicate: null,
  object: null,
};
const PREVIOUS_BRIEF = "2026-09-27T07:00:00.000Z";
const TODAY = "2026-09-29T07:00:00.000Z";

function railFailure(
  vault: string,
  db: ReturnType<typeof openLedger>,
  rail: string,
  finishedAt: string,
  error: string,
) {
  persistRunReceipt(db, vault, {
    ...emptyRunTotals(),
    run_id: `run-${rail}-${finishedAt}`,
    rail,
    started_at: finishedAt,
    finished_at: finishedAt,
    status: "degraded",
    stopped: null,
    errors: [error],
  });
}

describe("daily brief", () => {
  test("lists what changed since the previous brief, bounded and receipted", async () => {
    const f = fixture();
    try {
      await f.runBrief(PREVIOUS_BRIEF);

      // Before the window: must not appear.
      f.at("2026-09-26T10:00:00.000Z");
      const early = write(
        f.io,
        await storeClaim(f.db, putEvent(f.db), {
          ...LOOSE,
          target: "notes/too-early",
        }),
      );

      f.at("2026-09-28T09:00:00.000Z");
      const created = write(
        f.io,
        await storeClaim(f.db, putEvent(f.db), {
          ...LOOSE,
          target: "people/grace",
        }),
      );
      f.at("2026-09-28T09:05:00.000Z");
      write(
        f.io,
        await storeClaim(f.db, putEvent(f.db), {
          ...LOOSE,
          target: "people/grace",
          kind: "merge",
          body: "More.",
        }),
      );
      f.at("2026-09-28T09:10:00.000Z");
      const corrected = write(
        f.io,
        await storeClaim(f.db, putEvent(f.db), {
          ...LOOSE,
          target: "people/grace",
          kind: "merge",
          body: "Fixed.",
        }),
        {
          writer: "correction",
        },
      );
      f.at("2026-09-28T09:20:00.000Z");
      const undone = write(
        f.io,
        await storeClaim(f.db, putEvent(f.db), {
          ...LOOSE,
          target: "places/berlin",
        }),
      );
      await undoReceipt(
        { ...f.io, now: () => "2026-09-28T09:30:00.000Z" },
        undone.receipt_id,
      );
      // More new pages than one list names.
      for (let index = 0; index < 12; index += 1) {
        f.at(`2026-09-28T10:${String(index).padStart(2, "0")}:00.000Z`);
        write(
          f.io,
          await storeClaim(f.db, putEvent(f.db), {
            ...LOOSE,
            target: `topics/item-${index}`,
          }),
        );
      }
      // Unwritten live claim: extraction backlog.
      await storeClaim(f.db, putEvent(f.db), {
        ...LOOSE,
        target: "topics/pending",
      });
      railFailure(
        f.vault,
        f.db,
        "sync",
        "2026-09-28T13:00:00.000Z",
        "model response rejected",
      );
      railFailure(
        f.vault,
        f.db,
        "sync",
        "2026-09-28T14:00:00.000Z",
        "model response rejected",
      );
      railFailure(
        f.vault,
        f.db,
        "sync",
        "2026-09-25T14:00:00.000Z",
        "old failure outside the window",
      );

      const { receipt, path, text } = await f.runBrief(TODAY, "fixture:model");
      expect(receipt.status).toBe("ok");

      expect(text).toContain(`Covers ${PREVIOUS_BRIEF} to ${TODAY}.`);
      // 12 loop items plus grace and berlin created; berlin was later undone.
      expect(text).toContain("- New pages: 14");
      expect(text).toContain("`people/grace.md`");
      expect(text).toContain("and 4 more");
      expect(text).not.toContain(early.page_path);
      expect(text).toContain("- Updated pages: 1");
      expect(text).toContain("- Corrected pages: 1");
      expect(text).toContain("- Undone writes: 1");
      expect(text).toContain(`\`${corrected.page_path}\``);
      expect(text).toContain(`\`${created.page_path}\``);
      expect(text).toContain(
        "sync degraded in 2 runs, last 2026-09-28T14:00:00.000Z: model response rejected",
      );
      expect(text).not.toContain("old failure outside the window");
      expect(text).toContain("- Live claims not yet written to canon: 1");
      expect(text).toContain("- Canon writing: on (fixture:model)");
      expect(text).toMatch(/- New ledger events in this window: \d+/);
      // At most ten pages named per list.
      expect(
        text.split("\n").filter((line) => /^ {2}- `topics\/item-/.test(line))
          .length,
      ).toBeLessThanOrEqual(10);

      const parsed = parseFrontmatter(text);
      expect(validatePage(parsed.data)).toEqual([]);
      expect(parsed.data["sources"]).toEqual([]);
      const relPath = path.slice(f.vault.length + 1);
      expect(isMachineOriginPath(relPath)).toBe(true);
      expect(
        doctorVault(f.vault, f.db).pages.find((page) => page.page === relPath)
          ?.errors,
      ).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  test("a quiet day still reports real state and never a boilerplate-only page", async () => {
    const f = fixture();
    try {
      const { text } = await f.runBrief(TODAY);
      expect(text).toContain("## Canon");
      expect(text).toContain(
        "No canon page was created, updated, corrected or undone",
      );
      expect(text).toContain("Every rail run in this window finished ok.");
      expect(text).toContain("- Live claims not yet written to canon: 0");
      expect(text).toContain("- Ledger events past the extraction cursor: 0");
      expect(text).toContain("- Canon writing: off (no model configured");
      expect(text).toContain("There is no review queue");
      expect(text).toContain("kizuki tell");
      expect(text).not.toContain("kizuki review");
    } finally {
      f.db.close();
    }
  });

  test("the extraction backlog counts ledger events after the extraction cursor", async () => {
    const f = fixture();
    try {
      const first = putEvent(f.db);
      putEvent(f.db);
      putEvent(f.db);
      const row = f.db
        .query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id = ?")
        .get(first);
      const cursor = `${row?.accepted_at}\t${first}`;
      f.db.transaction(() => advanceExtractCheckpoint(f.db, "extract", cursor))();
      const { text } = await f.runBrief(TODAY);
      expect(text).toContain("- Ledger events past the extraction cursor: 2");
    } finally {
      f.db.close();
    }
  });

  test("a second run on the same day covers the same window", async () => {
    const f = fixture();
    try {
      await f.runBrief(PREVIOUS_BRIEF);
      f.at("2026-09-28T09:00:00.000Z");
      write(
        f.io,
        await storeClaim(f.db, putEvent(f.db), {
          ...LOOSE,
          target: "people/grace",
        }),
      );
      await f.runBrief(TODAY);
      const again = await f.runBrief("2026-09-29T15:00:00.000Z");
      expect(again.text).toContain(
        `Covers ${PREVIOUS_BRIEF} to 2026-09-29T15:00:00.000Z.`,
      );
      expect(again.text).toContain("- New pages: 1");
    } finally {
      f.db.close();
    }
  });
});

describe("brief page repair", () => {
  const LEGACY_BRIEF = [
    "---",
    'id: "rollup:brief-2026-09-17"',
    'title: "Daily brief 2026-09-17"',
    'type: "rollup"',
    'status: "active"',
    'sensitivity: "personal"',
    'taint: "clean"',
    'x-brief-producer: "deterministic"',
    "---",
    "# Brief 2026-09-17",
    "",
    "- canon writing: off",
    "",
  ].join("\n");

  function seedLegacy(
    vault: string,
    name = "brief-2026-09-17.md",
    text = LEGACY_BRIEF,
  ): string {
    // Owner-only modes, as the daemon's own notifier creates them.
    mkdirSync(join(vault, "dashboards"), { recursive: true, mode: 0o700 });
    const path = join(vault, "dashboards", name);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  }

  function invalidBriefs(f: ReturnType<typeof fixture>): string[] {
    return doctorVault(f.vault, f.db)
      .pages.filter((page) => page.errors.length > 0)
      .map((page) => page.page);
  }

  test("the doctor sweep rewrites a daemon brief that fails the page schema and receipts it", async () => {
    const f = fixture();
    try {
      const path = seedLegacy(f.vault);
      expect(invalidBriefs(f)).toEqual(["dashboards/brief-2026-09-17.md"]);

      const sweep = await runRail(f.db, f.vault, "doctor-sweep", {
        now: () => TODAY,
      });
      expect(sweep.errors).toEqual([]);
      expect(sweep.status).toBe("ok");
      expect(sweep.pages_repaired).toBe(1);
      expect(getRunReceipt(f.db, sweep.run_id)?.pages_repaired).toBe(1);

      const repaired = parseFrontmatter(readFileSync(path, "utf8"));
      expect(repaired.data["sources"]).toEqual([]);
      expect(repaired.data["id"]).toBe("rollup:brief-2026-09-17");
      expect(repaired.body).toContain("- canon writing: off");
      expect(invalidBriefs(f)).toEqual([]);

      const again = await runRail(f.db, f.vault, "doctor-sweep", {
        now: () => "2026-09-29T08:00:00.000Z",
      });
      expect(again.pages_repaired).toBeUndefined();
    } finally {
      f.db.close();
    }
  });

  test("the brief rail repairs older invalid briefs after writing its own", async () => {
    const f = fixture();
    try {
      seedLegacy(f.vault);
      const { receipt } = await f.runBrief(TODAY);
      expect(receipt.pages_repaired).toBe(1);
      expect(invalidBriefs(f)).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  test("a page the writer refuses to replace degrades the sweep instead of vanishing", async () => {
    const f = fixture();
    try {
      const path = seedLegacy(f.vault);
      // Group-writable: the canon file guard refuses to replace it.
      chmodSync(path, 0o664);
      const sweep = await runRail(f.db, f.vault, "doctor-sweep", { now: () => TODAY });
      expect(sweep.status).toBe("degraded");
      expect(sweep.errors).toEqual(["brief-repair-failed"]);
      expect(sweep.pages_repaired).toBeUndefined();
      expect(invalidBriefs(f)).toEqual(["dashboards/brief-2026-09-17.md"]);

      chmodSync(path, 0o600);
      const retry = await runRail(f.db, f.vault, "doctor-sweep", { now: () => "2026-09-29T08:00:00.000Z" });
      expect(retry.status).toBe("ok");
      expect(retry.pages_repaired).toBe(1);
    } finally {
      f.db.close();
    }
  });

  test("a page the daemon did not write, or cannot be read, is left alone", async () => {
    const f = fixture();
    try {
      const foreign = seedLegacy(
        f.vault,
        "brief-2026-09-18.md",
        LEGACY_BRIEF.replace("rollup:brief-2026-09-17", "notes:mine"),
      );
      const broken = seedLegacy(
        f.vault,
        "brief-2026-09-19.md",
        "no frontmatter here\n",
      );
      const other = seedLegacy(f.vault, "weekly.md", LEGACY_BRIEF);
      const before = [foreign, broken, other].map((path) =>
        readFileSync(path, "utf8"),
      );

      const sweep = await runRail(f.db, f.vault, "doctor-sweep", {
        now: () => TODAY,
      });
      expect(sweep.pages_repaired).toBeUndefined();
      expect(
        [foreign, broken, other].map((path) => readFileSync(path, "utf8")),
      ).toEqual(before);
      expect(
        existsSync(join(f.vault, "dashboards", "brief-2026-09-17.md")),
      ).toBe(false);
    } finally {
      f.db.close();
    }
  });
});
