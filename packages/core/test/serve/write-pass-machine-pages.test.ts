import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import { listCanonReceipts } from "../../src/canon/receipts";
import { getClaim } from "../../src/claims/store";
import type { ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import { runWritePass } from "../../src/serve/write-pass";
import { initVault } from "../../src/vault/init";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { putEvent } from "../claims/helpers";
import { storeClaim } from "../canon/helpers";

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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-machine-pages-"));
  roots.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const pass = () =>
    runWritePass(db, vault, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "fixture:idle",
      producer: IDLE_MODEL,
      claims: { db },
    });
  return { vault, db, pass };
}

const TARGET = "entities/patches/persona/soul";
const PAGE = "auto/entities/patches/persona/soul.md";

/** A claim with no subject and no claim key, so only the target path can name its page. */
function claimFor(db: ReturnType<typeof openLedger>, note: string) {
  return storeClaim(db, putEvent(db), {
    kind: "entity",
    target: TARGET,
    subject: null,
    subjects: [],
    predicate: null,
    object: null,
    body: `The persona soul notes ${note}.`,
    frontmatter: { type: "topic", title: "Persona soul" },
  });
}

test("a later claim for a target already materialised under auto/ updates that page", async () => {
  const f = fixture();
  try {
    const first = await claimFor(f.db, "warm");
    expect((await f.pass()).errors).toEqual([]);
    expect(existsSync(join(f.vault, PAGE))).toBe(true);
    const created = listCanonReceipts(f.db, { page_path: PAGE });
    expect(created).toHaveLength(1);

    const second = await claimFor(f.db, "slow");
    const result = await f.pass();
    expect(result.errors).toEqual([]);
    expect(result.claims_written).toBe(1);

    const receipts = listCanonReceipts(f.db, { page_path: PAGE });
    expect(receipts).toHaveLength(2);
    const edit = receipts.find((receipt) => receipt.page_action === "edit");
    expect(edit).toBeDefined();
    expect(edit?.before_hash).toBe(created[0]?.after_hash ?? "missing");
    expect(edit?.after_hash).not.toBe(edit?.before_hash ?? "");
    expect(edit?.claim_ids).toEqual([second.claim_id]);
    // No duplicate page appears at the human path, and the page id is stable.
    expect(existsSync(join(f.vault, "entities/patches/persona/soul.md"))).toBe(
      false,
    );
    const page = parseFrontmatter(readFileSync(join(f.vault, PAGE), "utf8"));
    expect(page.body).toContain("slow");
    expect(getClaim(f.db, first.claim_id)?.receipt_id).toBe(
      created[0]?.receipt_id ?? "missing",
    );
    expect(getClaim(f.db, second.claim_id)?.receipt_id).toBe(
      edit?.receipt_id ?? "missing",
    );
  } finally {
    f.db.close();
  }
});

test("two pending claims for one already-written target both land as edits", async () => {
  const f = fixture();
  try {
    await claimFor(f.db, "warm");
    expect((await f.pass()).errors).toEqual([]);

    const second = await claimFor(f.db, "slow");
    const third = await claimFor(f.db, "dry");
    const result = await f.pass();
    expect(result.errors).toEqual([]);
    expect(result.claims_written).toBe(2);

    const receipts = listCanonReceipts(f.db, { page_path: PAGE });
    expect(receipts.map((receipt) => receipt.page_action).sort()).toEqual([
      "create",
      "edit",
      "edit",
    ]);
    const edited = receipts.filter((receipt) => receipt.page_action === "edit");
    expect(edited.flatMap((receipt) => receipt.claim_ids).sort()).toEqual(
      [second.claim_id, third.claim_id].sort(),
    );
    // Each edit chains onto the hash the previous receipt left behind.
    const ordered = [...receipts].sort((left, right) =>
      left.at < right.at ? -1 : left.at > right.at ? 1 : 0,
    );
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]?.before_hash).toBe(
        ordered[index - 1]?.after_hash ?? "missing",
      );
    }
    // The second pass finds nothing left unwritten and does not fail again.
    expect((await f.pass()).errors).toEqual([]);
  } finally {
    f.db.close();
  }
});
