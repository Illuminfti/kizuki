import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import { listCanonReceipts } from "../../src/canon/receipts";
import { undoReceipt } from "../../src/canon/undo";
import { getClaim, listClaims } from "../../src/claims/store";
import {
  PAGE_CANDIDATE_KEY,
  PAGE_CANDIDATE_SCHEMA,
} from "../../src/contracts/page-candidate";
import type { ProducerPort } from "../../src/contracts/producer";
import { runBatch } from "../../src/ingest/run";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { runRail } from "../../src/serve/rails";
import { getRunReceipt } from "../../src/serve/receipts";
import { runWritePass } from "../../src/serve/write-pass";
import { proposalsForEvent } from "../../src/staging/producers";
import { fileProposal } from "../../src/staging/proposals";
import { initVault, VAULT_DIR_MODE, VAULT_FILE_MODE } from "../../src/vault/init";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { validEvent } from "../fixtures";

// Each write pass opens a full vault; a loaded machine needs more than the default.
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const IDLE_MODEL: ProducerPort = {
  descriptor: {
    id: "kizuki.producer.idle-test",
    kind: "producer",
    contract: "kizuki.producer/v1",
    contract_minor: 1,
    supports: ["model"],
    requires_lease: false,
    optional_package: null,
  },
  health: async () => ({ status: "ready", detail: {} }),
  close: async () => undefined,
  produce: async () => ({
    status: "ok",
    claims: [],
    usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
  }),
};

const GRANTED = { page_candidates: true } as const;
const TARGET = "entities/atlas";
const PAGE = "auto/entities/atlas.md";
const RECORD = "wiki/atlas.md";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-page-revisions-"));
  roots.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const pass = () =>
    runWritePass(db, vault, {
      budget: createBudgetTracker({ canon_writes_per_run: 16 }),
      model_ref: "fixture:idle",
      producer: IDLE_MODEL,
      claims: { db },
    });
  return { root, vault, db, pass };
}

type Fixture = ReturnType<typeof fixture>;

interface Revision {
  readonly text: string;
  readonly extensions?: Record<string, unknown>;
  readonly record?: string;
  readonly target?: string;
  readonly delivery?: string;
}

function eventFor(revision: Revision) {
  return {
    ...validEvent(),
    source_record_id: revision.record ?? RECORD,
    subjects: [],
    text: revision.text,
    metadata: {
      ...(revision.delivery === undefined ? {} : { delivery: revision.delivery }),
      [PAGE_CANDIDATE_KEY]: {
        schema: PAGE_CANDIDATE_SCHEMA,
        type: "topic",
        title: "Atlas",
        target: revision.target ?? TARGET,
        extensions: revision.extensions ?? {},
        confidence: 1,
      },
    },
  };
}

/** A source revision arriving the way a granted connector's batch does. */
function revise(f: Fixture, revision: Revision): void {
  const result = runBatch(
    f.db,
    { events: [eventFor(revision)], cursor: null, has_more: false },
    GRANTED,
  );
  expect(result.errors).toEqual([]);
  expect(result.stored).toBe(1);
}

/** A revision as the importer filed it before page candidates carried a claim key. */
function reviseLegacy(f: Fixture, revision: Revision): void {
  const accepted = accept(f.db, eventFor(revision));
  if (accepted.status !== "stored") throw new Error(`event was ${accepted.status}`);
  const page = proposalsForEvent(accepted.event, GRANTED).find(
    (proposal) => proposal.target === (revision.target ?? TARGET),
  );
  if (page === undefined) throw new Error("no page proposal");
  const { claim_key: _claimKey, ...keyless } = page as typeof page & {
    claim_key?: string;
  };
  fileProposal(f.db, keyless);
}

function readPage(f: Fixture, relPath = PAGE) {
  return parseFrontmatter(readFileSync(join(f.vault, relPath), "utf8"));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("a new page candidate carries a stable claim key per source record", () => {
  const f = fixture();
  try {
    revise(f, { text: "# Atlas\n\nfirst body" });
    const [first] = listClaims(f.db, { status: "live", limit: 10 }).filter(
      (claim) => claim.target === TARGET,
    );
    expect(first?.claim_key).toMatch(/^[0-9a-f]{64}$/);

    revise(f, { text: "# Atlas\n\nsecond body" });
    const same = listClaims(f.db, { limit: 10 }).filter(
      (claim) => claim.target === TARGET,
    );
    expect(same).toHaveLength(2);
    expect(new Set(same.map((claim) => claim.claim_key)).size).toBe(1);

    revise(f, {
      text: "# Other\n\nunrelated",
      record: "wiki/other.md",
      target: "entities/other",
    });
    const other = listClaims(f.db, { limit: 10 }).find(
      (claim) => claim.target === "entities/other",
    );
    expect(other?.claim_key).toMatch(/^[0-9a-f]{64}$/);
    expect(other?.claim_key).not.toBe(first?.claim_key);
  } finally {
    f.db.close();
  }
});

test("three revisions of one page leave one body copy and the newest fields", async () => {
  const f = fixture();
  try {
    revise(f, {
      text: "# Atlas\n\nfirst body",
      extensions: { "x-status": "draft", "x-old": "kept" },
    });
    expect((await f.pass()).errors).toEqual([]);
    revise(f, {
      text: "# Atlas\n\nsecond body",
      extensions: { "x-status": "review" },
    });
    expect((await f.pass()).errors).toEqual([]);
    revise(f, {
      text: "# Atlas\n\nthird body",
      extensions: { "x-status": "final" },
    });
    const result = await f.pass();
    expect(result.errors).toEqual([]);
    expect(result.claims_written).toBe(1);

    const page = readPage(f);
    expect(occurrences(page.body, "# Atlas")).toBe(1);
    expect(page.body).toContain("third body");
    expect(page.body).not.toContain("first body");
    expect(page.body).not.toContain("second body");
    expect(page.data["x-status"]).toBe("final");
    expect(page.data["x-old"]).toBe("kept");
    expect((page.data["sources"] as string[]).length).toBe(3);
    expect(listCanonReceipts(f.db, { page_path: PAGE })).toHaveLength(3);
    expect(
      listClaims(f.db, { status: "live", limit: 10 }).filter(
        (c) => c.target === TARGET,
      ),
    ).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("revisions filed before a pass runs still leave only the newest body", async () => {
  const f = fixture();
  try {
    revise(f, { text: "# Atlas\n\nfirst body" });
    expect((await f.pass()).errors).toEqual([]);
    revise(f, { text: "# Atlas\n\nsecond body" });
    revise(f, { text: "# Atlas\n\nthird body" });
    const result = await f.pass();
    expect(result.errors).toEqual([]);
    expect(result.claims_written).toBe(1);
    const page = readPage(f);
    expect(occurrences(page.body, "# Atlas")).toBe(1);
    expect(page.body).toContain("third body");
  } finally {
    f.db.close();
  }
});

test("a frontmatter-only edit does not duplicate the body", async () => {
  const f = fixture();
  try {
    revise(f, {
      text: "# Atlas\n\nsame body",
      extensions: { "x-status": "draft" },
    });
    expect((await f.pass()).errors).toEqual([]);
    revise(f, {
      text: "# Atlas\n\nsame body",
      extensions: { "x-status": "final", "x-owner": "ops" },
    });
    expect((await f.pass()).errors).toEqual([]);

    const page = readPage(f);
    expect(occurrences(page.body, "same body")).toBe(1);
    expect(page.data["x-status"]).toBe("final");
    expect(page.data["x-owner"]).toBe("ops");
  } finally {
    f.db.close();
  }
});

test("a body truncation marker does not outlive the revision that set it", async () => {
  const f = fixture();
  try {
    revise(f, { text: `# Atlas\n\n${"a".repeat(64_001)}` });
    expect((await f.pass()).errors).toEqual([]);
    expect(readPage(f).data["x-body-truncated"]).toBe(true);
    revise(f, { text: "# Atlas\n\nshort now" });
    expect((await f.pass()).errors).toEqual([]);
    const page = readPage(f);
    expect(page.data["x-body-truncated"]).toBeUndefined();
    expect(page.body).toContain("short now");
  } finally {
    f.db.close();
  }
});

test("undo of the second receipt restores revision one and its claim", async () => {
  const f = fixture();
  try {
    revise(f, {
      text: "# Atlas\n\nfirst body",
      extensions: { "x-status": "draft" },
    });
    expect((await f.pass()).errors).toEqual([]);
    const [created] = listCanonReceipts(f.db, { page_path: PAGE });
    const revisionOne = readFileSync(join(f.vault, PAGE), "utf8");

    revise(f, {
      text: "# Atlas\n\nsecond body",
      extensions: { "x-status": "final" },
    });
    expect((await f.pass()).errors).toEqual([]);
    const edit = listCanonReceipts(f.db, { page_path: PAGE }).find(
      (r) => r.page_action === "edit",
    );
    expect(edit).toBeDefined();
    expect(readFileSync(join(f.vault, PAGE), "utf8")).not.toBe(revisionOne);

    await undoReceipt({ db: f.db, vault_path: f.vault }, edit!.receipt_id);
    expect(readFileSync(join(f.vault, PAGE), "utf8")).toBe(revisionOne);
    expect(getClaim(f.db, created!.claim_ids[0]!)?.status).toBe("live");
    expect(getClaim(f.db, edit!.claim_ids[0]!)?.status).toBe("reverted");
    // The next pass has nothing to redo: the undone revision is not rewritten.
    const after = await f.pass();
    expect(after.errors).toEqual([]);
    expect(after.claims_written).toBe(0);
    expect(readFileSync(join(f.vault, PAGE), "utf8")).toBe(revisionOne);
    revise(f, {
      text: "# Atlas\n\nfirst body",
      extensions: { "x-status": "draft" },
      delivery: "after-undo",
    });
    expect((await f.pass()).claims_written).toBe(0);
    expect(listClaims(f.db, { status: "live", limit: 20 }).filter(c => c.target === TARGET)).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("the first revision after a legacy import supersedes the keyless claims cleanly", async () => {
  const f = fixture();
  try {
    // Legacy state: the import filed keyless claims. The first was written; a
    // later edit arrived and was appended; a third is still waiting.
    reviseLegacy(f, {
      text: "# Atlas\n\nlegacy one",
      extensions: { "x-status": "draft" },
    });
    expect((await f.pass()).errors).toEqual([]);
    reviseLegacy(f, {
      text: "# Atlas\n\nlegacy two",
      extensions: { "x-status": "review" },
    });
    expect((await f.pass()).errors).toEqual([]);
    reviseLegacy(f, {
      text: "# Atlas\n\nlegacy three",
      extensions: { "x-status": "review2" },
    });
    const grown = readPage(f);
    expect(occurrences(grown.body, "# Atlas")).toBe(2);
    expect(
      listClaims(f.db, { status: "live", limit: 20 }).every(
        (c) => c.claim_key === null || c.target !== TARGET,
      ),
    ).toBe(true);

    revise(f, {
      text: "# Atlas\n\nfresh edit",
      extensions: { "x-status": "final" },
    });
    const result = await f.pass();
    expect(result.errors).toEqual([]);

    const page = readPage(f);
    expect(occurrences(page.body, "# Atlas")).toBe(1);
    expect(page.body).toContain("fresh edit");
    expect(page.body).not.toContain("legacy");
    expect(page.data["x-status"]).toBe("final");
    const live = listClaims(f.db, { status: "live", limit: 20 }).filter(
      (c) => c.target === TARGET,
    );
    expect(live).toHaveLength(1);
    // Nothing is left waiting to be retried.
    const again = await f.pass();
    expect(again.errors).toEqual([]);
    expect(again.claims_written).toBe(0);
  } finally {
    f.db.close();
  }
});

test("a page whose mapping moves keeps its canon page and takes the new revision", async () => {
  const f = fixture();
  try {
    revise(f, { text: "# Atlas\n\nbefore the move" });
    expect((await f.pass()).errors).toEqual([]);
    revise(f, { text: "# Atlas\n\nafter the move", target: "entities/atlas-moved" });
    expect((await f.pass()).errors).toEqual([]);
    const page = readPage(f);
    expect(page.body).toContain("after the move");
    expect(page.body).not.toContain("before the move");
    expect(existsSync(join(f.vault, "auto/entities/atlas-moved.md"))).toBe(false);
    expect(listCanonReceipts(f.db, { page_path: PAGE })).toHaveLength(2);
  } finally {
    f.db.close();
  }
});

test("a create over a page the writer cannot bind ends as a receipted skip, once", async () => {
  const f = fixture();
  try {
    // A file already sits at the loop's path, without a page id the writer could bind.
    mkdirSync(join(f.vault, "auto/entities"), {
      recursive: true,
      mode: VAULT_DIR_MODE,
    });
    writeFileSync(
      join(f.vault, PAGE),
      "---\ntype: topic\ntitle: Hand made\n---\n\nnotes\n",
      { mode: VAULT_FILE_MODE },
    );
    revise(f, { text: "# Atlas\n\nfirst body" });

    const receipt = await runRail(f.db, f.vault, "sync", {
      hooks: { producer: IDLE_MODEL, claims: { db: f.db }, model_ref: "fixture:idle" },
    });
    // A skip is an outcome, not a failure: the run is not degraded.
    expect(receipt).toMatchObject({ status: "ok", errors: [], claims_written: 0, claims_skipped: { page_exists: 1 } });
    expect(getRunReceipt(f.db, receipt.run_id)?.claims_skipped).toEqual({ page_exists: 1 });
    expect(readFileSync(join(f.vault, PAGE), "utf8")).toContain("notes");
    const skipped = listClaims(f.db, { status: "skipped", limit: 10 }).filter(
      (c) => c.target === TARGET,
    );
    expect(skipped).toHaveLength(1);

    const second = await f.pass();
    expect(second.errors).toEqual([]);
    expect(second.claims_skipped).toEqual({});
    expect(
      listClaims(f.db, { status: "skipped", limit: 10 }).filter(
        (c) => c.target === TARGET,
      ),
    ).toHaveLength(1);
  } finally {
    f.db.close();
  }
});


test("a later source revision can return to an earlier body", async () => {
  const f = fixture();
  try {
    revise(f, { text: "# Atlas\n\noriginal", delivery: "one" });
    expect((await f.pass()).errors).toEqual([]);
    revise(f, { text: "# Atlas\n\nchanged", delivery: "two" });
    expect((await f.pass()).errors).toEqual([]);
    revise(f, { text: "# Atlas\n\noriginal", delivery: "three" });
    const result = await f.pass();
    expect(result.errors).toEqual([]);
    expect(result.claims_written).toBe(1);
    expect(readPage(f).body).toContain("original");
    expect(readPage(f).body).not.toContain("changed");
  } finally { f.db.close(); }
});

test("identical pages from different source records retain separate keys", () => {
  const f = fixture();
  try {
    revise(f, { text: "# Atlas\n\nidentical", record: "wiki/first.md" });
    revise(f, { text: "# Atlas\n\nidentical", record: "wiki/second.md" });
    const pages = listClaims(f.db, { status: "live", limit: 20 }).filter(c => c.target === TARGET);
    expect(pages).toHaveLength(2);
    expect(new Set(pages.map(c => c.claim_key)).size).toBe(2);
  } finally { f.db.close(); }
});

test("a keyed revision does not assign keys to legacy claims and its undo restores them", async () => {
  const f = fixture();
  try {
    reviseLegacy(f, { text: "# Atlas\n\nlegacy", delivery: "one" });
    expect((await f.pass()).errors).toEqual([]);
    const legacy = listClaims(f.db, { status: "live", limit: 20 }).find(c => c.target === TARGET)!;
    const before = readFileSync(join(f.vault, PAGE), "utf8");
    // The first keyed delivery may have exactly the same prose and fields.
    revise(f, { text: "# Atlas\n\nlegacy", delivery: "two" });
    expect((await f.pass()).errors).toEqual([]);
    expect(getClaim(f.db, legacy.claim_id)).toMatchObject({ claim_key: null, status: "superseded" });
    const edit = listCanonReceipts(f.db, { page_path: PAGE }).find(r => r.page_action === "edit")!;
    await undoReceipt({ db: f.db, vault_path: f.vault }, edit.receipt_id);
    expect(getClaim(f.db, legacy.claim_id)).toMatchObject({ claim_key: null, status: "live" });
    expect(readFileSync(join(f.vault, PAGE), "utf8")).toBe(before);
  } finally { f.db.close(); }
});

test("source revisions never supersede a higher-authority keyed correction", async () => {
  const f = fixture();
  try {
    revise(f, { text: "# Atlas\n\ncorrected" });
    expect((await f.pass()).errors).toEqual([]);
    const original = listClaims(f.db, { status: "live", limit: 20 }).find(c => c.target === TARGET)!;
    // Stored fixture represents a terminal correction on the page's key.
    f.db.query("UPDATE claims SET authority = 'owner_correction' WHERE claim_id = ?").run(original.claim_id);
    const before = readFileSync(join(f.vault, PAGE), "utf8");
    revise(f, { text: "# Atlas\n\nsource revision" });
    expect((await f.pass()).errors).toEqual([]);
    expect(getClaim(f.db, original.claim_id)?.status).toBe("live");
    expect(readFileSync(join(f.vault, PAGE), "utf8")).toBe(before);
  } finally { f.db.close(); }
});


test("failure journaling supersession rolls back the revision's claims and proposal", async () => {
  const f = fixture();
  try {
    revise(f, { text: "# Atlas\n\nfirst body" });
    expect((await f.pass()).errors).toEqual([]);
    const original = listClaims(f.db, { status: "live", limit: 20 }).find(c => c.target === TARGET)!;
    const before = readFileSync(join(f.vault, PAGE), "utf8");
    const accepted = accept(f.db, eventFor({ text: "# Atlas\n\nnext body" }));
    if (accepted.status !== "stored") throw new Error("fixture event not stored");
    const proposal = proposalsForEvent(accepted.event, GRANTED).find(p => p.target === TARGET)!;
    f.db.exec(`CREATE TRIGGER fail_revision BEFORE INSERT ON claim_supersessions
      BEGIN SELECT RAISE(ABORT, 'synthetic supersession failure'); END`);
    expect(() => fileProposal(f.db, proposal)).toThrow("synthetic supersession failure");
    expect(getClaim(f.db, original.claim_id)?.status).toBe("live");
    expect(listClaims(f.db, { limit: 20 }).filter(c => c.target === TARGET)).toHaveLength(1);
    expect(readFileSync(join(f.vault, PAGE), "utf8")).toBe(before);
    f.db.exec("DROP TRIGGER fail_revision");
    fileProposal(f.db, proposal);
    expect((await f.pass()).errors).toEqual([]);
    expect(readPage(f).body).toContain("next body");
  } finally { f.db.close(); }
});


test("a new revision retires legacy pending claims before the writer revives them", async () => {
  const f = fixture();
  try {
    reviseLegacy(f, { text: "# Atlas\n\nlegacy written" });
    expect((await f.pass()).errors).toEqual([]);
    reviseLegacy(f, { text: "# Atlas\n\nlegacy pending" });
    const pending = listClaims(f.db, { status: "live", limit: 20 }).find(c => c.target === TARGET && c.receipt_id === null)!;
    // Older pending proposals migrated to this revivable claim state.
    f.db.query("UPDATE claims SET status = 'skipped', retracted_at = NULL WHERE claim_id = ?").run(pending.claim_id);
    revise(f, { text: "# Atlas\n\nnewest body" });
    expect(getClaim(f.db, pending.claim_id)).toMatchObject({ claim_key: null, status: "superseded" });
    const result = await f.pass();
    expect(result.errors).toEqual([]);
    expect(result.claims_written).toBe(1);
    expect(occurrences(readPage(f).body, "# Atlas")).toBe(1);
    expect(readPage(f).body).toContain("newest body");
    expect(readPage(f).body).not.toContain("legacy");
  } finally { f.db.close(); }
});
