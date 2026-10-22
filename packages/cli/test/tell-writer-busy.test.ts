import { afterEach, expect, test, setDefaultTimeout, spyOn } from "bun:test";
import { join } from "node:path";
import * as core from "@kizuki/core";
import { accept, applyCanonWrite, createBudgetTracker, insertClaim, resolveTarget, runWritePass } from "@kizuki/core";
import type { CaptureEventInput, Claim, ProducerPort } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { withVaultMutationAsync } from "../../core/src/vault/mutation-scope";
import { tellCommand } from "../src/commands/tell";
import { createHelpers } from "./helpers";

setDefaultTimeout(90_000);

const { cleanup, runCliAsync, tempVault } = createHelpers();
afterEach(cleanup);

const producer: ProducerPort = {
  descriptor: { id: "kizuki.producer.fixture", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
  health: async () => ({ status: "ready", detail: {} }),
  close: async () => {},
  produce: async () => ({ status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 }, dropped: [] }),
};

function event(name: string): CaptureEventInput {
  return {
    schema: "kizuki.event/v1", connector_id: "fixture", source_record_id: `rec-${name}`, kind: "message",
    occurred_at: "2026-02-28T10:30:00Z", observed_at: "2026-03-01T00:00:00Z", text: `${name} works at Acme.`,
    subjects: [{ subject_id: `person:${name}`, role: "from", display_name: name }], sensitivity_hint: "personal",
    deleted: false, attachments: [], metadata: {},
  };
}

async function file(db: ReturnType<typeof openLedger>, name: string): Promise<Claim> {
  const accepted = accept(db, event(name));
  if (accepted.status !== "stored") throw new Error(`failed to store event: ${JSON.stringify(accepted)}`);
  const stored = await insertClaim({ db }, {
    kind: "claim", target: `people/${name}`, subject: `person:${name}`, predicate: "employment.works_at", object: "acme",
    polarity: "positive", body: `${name} works at Acme.`, frontmatter: { type: "person", title: name },
    provenance: [accepted.event.event_id], subjects: [`person:${name}`], producer: "deterministic", confidence: 0.8,
    sensitivity: "personal", taint: "clean",
    events: [{ event_id: accepted.event.event_id, connector_id: "fixture", taint: "untrusted", text: `${name} works at Acme.` }],
  });
  if (stored.outcome !== "stored") throw new Error(`fixture claim was ${stored.outcome}`);
  return stored.claim;
}

test("legacy tell retries an observed busy writer without repeating correction effects", async () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    const first = await file(db, "grace");
    applyCanonWrite({ db, vault_path: setup.vault }, first, resolveTarget({ db, vault_path: setup.vault }, first), {
      writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
    });
    const effects = () => ["events", "claims", "canon_receipts"].map(table =>
      db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = effects();
    let busy!: () => void, release!: () => void;
    const firstBusy = new Promise<void>(resolve => { busy = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const original = core.correct;
    const observed = spyOn(core, "correct").mockImplementation(async (...args) => {
      try { return await original(...args); }
      catch (error) {
        if (error instanceof core.CorrectError && error.code === "writer_busy") busy();
        throw error;
      }
    });
    const held = withVaultMutationAsync({ vault_path: setup.vault, db }, () => released);
    const stdout: string[] = [], stderr: string[] = [];
    let command: Promise<number> | undefined;
    try {
      command = tellCommand.run({ env: setup.env, vaultOverride: setup.vault,
        stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
        out: line => stdout.push(line), err: line => stderr.push(line),
        prompt: async () => { throw new Error("unexpected prompt"); },
      }, ["grace is at initech now, not acme", "--claim", first.claim_id, "--json"]);
      await Promise.race([firstBusy, command.then(() => { throw new Error("tell finished before a busy refusal was observed"); })]);
      expect(effects()).toEqual(before);
      release();
      await held;
      expect(await command).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0]!).data.receipt_id).toBeString();
      expect(observed.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(effects().map(rows => rows.length)).toEqual(before.map(rows => rows.length + 1));
    } finally {
      release();
      try { await held; }
      finally {
        try { await command?.catch(() => undefined); }
        finally { observed.mockRestore(); }
      }
    }
  } finally { db.close(); }
});

test("a tell issued while the loop writes canon waits for a page, not the pass, and lands", async () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    const first = await file(db, "grace");
    applyCanonWrite({ db, vault_path: setup.vault }, first, resolveTarget({ db, vault_path: setup.vault }, first), {
      writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
    });
    const written = () => db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_receipts").get()!.n;
    for (let index = 0; index < 12; index += 1) await file(db, `person${String.fromCharCode(97 + index)}`);

    const baseline = written();
    let finished = false;
    const pass = runWritePass(db, setup.vault, {
      budget: createBudgetTracker({ canon_writes_per_run: 32 }), model_ref: "fixture/model", claims: { db }, producer,
    }).finally(() => { finished = true; });
    while (written() === baseline) await new Promise((resolve) => setTimeout(resolve, 10));

    const started = performance.now();
    const tell = await runCliAsync(setup.env, "tell", "grace is at initech now, not acme", "--claim", first.claim_id, "--json");
    const waited = performance.now() - started;
    expect(tell.stderr).toBe("");
    expect(tell.exitCode).toBe(0);
    expect(JSON.parse(tell.stdout).data.receipt_id).toBeString();
    // The correction landed between two pages of the pass, and within the bounded wait.
    expect(finished).toBe(false);
    expect(waited).toBeLessThan(30_000);

    const result = await pass;
    expect(result.canon_writes).toBe(12);
    expect(result.errors).toEqual([]);
  } finally {
    db.close();
  }
});
