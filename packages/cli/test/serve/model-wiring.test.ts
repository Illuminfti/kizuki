import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { accept, insertClaim, openLedger } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import {
  defaultChatCompletion,
  startFakeEndpoint,
} from "../../../llm/test/fake-endpoint";
import type { FakeEndpoint } from "../../../llm/test/fake-endpoint";
import { createHelpers } from "../helpers";
import type { CliResult } from "../helpers";

/**
 * RFC 0002 §12.1 / docs/deploy-box-tailscale.md M4. Drives `kizuki serve`,
 * `doctor`, `audit` and `undo` through the public CLI seam against a real
 * (loopback, synthetic) OpenAI-compatible endpoint, so the model producer
 * actually runs rather than merely carrying a config label.
 *
 * The markdown-folder connector never sets `subjects` on the events it
 * emits (a fact recorded in docs/deploy-box-tailscale.md's M1 finding), so
 * a model-drafted claim citing a real subject can never survive
 * `kizuki.producer.model`'s "unknown_subject" filter if the ledger is
 * seeded through `kizuki import`. These fixtures seed one ledger event with
 * a real subject directly through `accept()`, the same pattern
 * `test/audit-undo.test.ts` already uses to drive `audit`/`undo` — the CLI
 * verb under test still runs only through `runCli`/`runCliLive`.
 *
 * Every call below that must reach the in-process fake endpoint uses
 * `runCliLive`, not `../helpers`' `runCli`. `runCli` shells out with
 * `Bun.spawnSync`, which blocks this test file's own event loop — the same
 * loop `startFakeEndpoint`'s `Bun.serve` needs to answer the child's
 * request. Proven empirically (a standalone repro script, not committed):
 * with `spawnSync` the child never got a response and hit its model
 * deadline every time; switching only the spawn call to the async
 * `Bun.spawn` below, with no other change, let the fake endpoint's handler
 * run while the child waited, and the exact same request completed in
 * under a second. `runCli` still drives the calls that need no live
 * endpoint (4.1, 4.5, and the post-extraction `doctor`/`audit`/`undo` reads).
 */

const { cleanup, runCli, tempVault } = createHelpers();

const CLI_MAIN = resolve(import.meta.dir, "../../src/main.ts");

async function runCliLive(
  env: Record<string, string | undefined>,
  ...args: string[]
): Promise<CliResult> {
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
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) spawnEnv[key] = value;
  }
  const proc = Bun.spawn([process.execPath, CLI_MAIN, ...args], {
    env: spawnEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

let endpoint: FakeEndpoint | null = null;

afterEach(() => {
  endpoint?.stop();
  endpoint = null;
  cleanup();
});

const MODEL_KEY_ENV = "KIZUKI_TEST_MODEL_KEY";
const MODEL_KEY_VALUE = "not-a-real-key";
const PREDICATE = "employment.role";

function subjectEvent(
  subjectId: string,
  displayName: string,
  text: string,
): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: "fixture",
    source_record_id: `rec-${crypto.randomUUID()}`,
    kind: "message",
    occurred_at: "2026-02-28T10:30:00Z",
    observed_at: "2026-03-01T00:00:00Z",
    text,
    subjects: [{ subject_id: subjectId, role: "from", display_name: displayName }],
    sensitivity_hint: "personal",
    deleted: false,
    attachments: [],
    metadata: {},
  };
}

function storeEvent(vault: string, event: CaptureEventInput): string {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const accepted = accept(db, event);
    if (accepted.status !== "stored") {
      throw new Error(`failed to store event: ${JSON.stringify(accepted)}`);
    }
    return accepted.event.event_id;
  } finally {
    db.close();
  }
}

/**
 * `kizuki.producer.model` only ever edits or extends a page that already
 * exists for a subject (`resolveTarget` in packages/core/src/canon/arbiter.ts
 * mints a fresh page only for `CREATE_KINDS`, and a model draft's `kind` is
 * never one of those) — real connectors that supply subjects get that page
 * from the deterministic producer's own entity proposal at ingest time
 * (packages/core/src/staging/producers.ts `entityProposal`). This mirrors
 * that proposal directly through the public `insertClaim` API, the same
 * composition `test/audit-undo.test.ts` already uses to seed a page.
 */
async function seedSubject(
  vault: string,
  subjectId: string,
  handle: string,
  displayName: string,
  text: string,
): Promise<string> {
  const eventId = storeEvent(vault, subjectEvent(subjectId, displayName, text));
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const entity = await insertClaim(
      { db },
      {
        kind: "entity",
        target: `people/${handle}`,
        subject: subjectId,
        body: `Stub entity page for \`${subjectId}\`.`,
        frontmatter: { type: "person", title: displayName },
        provenance: [eventId],
        subjects: [subjectId],
        producer: "deterministic",
        confidence: 0.5,
        sensitivity: "personal",
        taint: "clean",
      },
    );
    if (entity.outcome !== "stored") {
      throw new Error(`entity claim for ${subjectId} was ${entity.outcome}`);
    }
    return eventId;
  } finally {
    db.close();
  }
}

function toml(value: string | number): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

function writeServeToml(
  vault: string,
  llm: Record<string, string | number>,
  budget?: Record<string, number>,
): void {
  const lines = ["[ports.llm]"];
  for (const [key, value] of Object.entries(llm)) lines.push(`${key} = ${toml(value)}`);
  if (budget !== undefined) {
    lines.push("", "[budget]");
    for (const [key, value] of Object.entries(budget)) lines.push(`${key} = ${toml(value)}`);
  }
  writeFileSync(join(vault, ".kizuki", "serve.toml"), `${lines.join("\n")}\n`);
}

function claimFor(eventId: string, subject: string, body: string): Record<string, unknown> {
  return {
    kind: "claim",
    subject,
    predicate: PREDICATE,
    object: "runs partnerships at Acme",
    polarity: "positive",
    body,
    valid_from: null,
    valid_to: null,
    confidence: 0.7,
    sensitivity: "personal",
    event_ids: [eventId],
  };
}

function extractReply(claims: readonly Record<string, unknown>[]) {
  return (): Response => defaultChatCompletion(JSON.stringify({ claims }));
}

function unavailableReply(): Response {
  return new Response(null, { status: 503 });
}

interface Envelope<T> {
  data: T;
}

function data<T>(stdout: string): T {
  return (JSON.parse(stdout) as Envelope<T>).data;
}

interface AuditRow {
  receipt_id: string;
  writer: string;
  model_ref: string | null;
  page_path: string;
  before_hash: string | null;
  after_hash: string;
}

function auditRows(env: Record<string, string | undefined>): AuditRow[] {
  const listed = runCli(env, "audit", "--json");
  expect(listed.exitCode).toBe(0);
  return data<{ receipts: AuditRow[] }>(listed.stdout).receipts;
}

function sha256File(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

function runReceiptCount(vault: string): number {
  const path = join(vault, ".kizuki", "run-receipts.jsonl");
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0).length;
}

describe("kizuki serve model wiring (M4)", () => {
  test("4.1 off by default: no [ports], no canon writes, doctor says off", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "serve", "--once", "--no-http", "--json");
    expect(result.exitCode).toBe(0);
    expect(auditRows(setup.env)).toEqual([]);

    const doctor = runCli(setup.env, "doctor");
    expect(doctor.stdout).toContain(
      "canon writing: off (no model configured — connectors, ledger, search, timeline and undo still work)",
    );
  });

  test("4.2-4.4 a configured model extracts, writes a receipted claim, and undo reverts it", async () => {
    const setup = tempVault();
    endpoint = startFakeEndpoint();
    const eventId = await seedSubject(
      setup.vault,
      "person:grace",
      "grace",
      "Grace",
      "Grace mentioned she now runs partnerships at Acme.",
    );
    endpoint.reply = extractReply([
      claimFor(eventId, "person:grace", "Grace leads partnerships at Acme."),
    ]);
    writeServeToml(setup.vault, {
      id: "kizuki.llm.openai-compatible",
      base_url: endpoint.base_url,
      model: "test-model",
      secret_ref: `env:${MODEL_KEY_ENV}`,
      max_retries: 0,
    });
    const env = { ...setup.env, [MODEL_KEY_ENV]: MODEL_KEY_VALUE };

    const once = await runCliLive(env, "serve", "--once", "--no-http", "--json");
    expect(once.exitCode).toBe(0);

    const expectedModelRef = `kizuki.llm.openai-compatible:test-model@127.0.0.1`;
    const doctor = runCli(env, "doctor");
    expect(doctor.stdout).toContain(`canon writing: on (${expectedModelRef})`);

    const rows = auditRows(env);
    const written = rows.find((row) => row.writer === "loop" && row.model_ref === expectedModelRef);
    expect(written).toBeDefined();
    if (written === undefined) return;

    const pagePath = join(setup.vault, written.page_path);
    expect(existsSync(pagePath)).toBe(true);
    expect(sha256File(pagePath)).toBe(written.after_hash);

    const undone = runCli(env, "undo", written.receipt_id);
    expect(undone.exitCode).toBe(0);
    if (written.before_hash === null) {
      expect(existsSync(pagePath)).toBe(false);
    } else {
      expect(sha256File(pagePath)).toBe(written.before_hash);
    }
  });

  test("4.5 a plaintext secret fails closed before any rail runs", () => {
    const setup = tempVault();
    writeServeToml(setup.vault, {
      id: "kizuki.llm.openai-compatible",
      base_url: "http://127.0.0.1:9/v1",
      model: "test-model",
      secret_ref: "sk-literal",
    });

    const result = runCli(setup.env, "serve", "run", "sync", "--json");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("config_invalid");
    expect(runReceiptCount(setup.vault)).toBe(0);
  });

  test("4.6 the run budget stops the write pass and records what stopped it", async () => {
    const setup = tempVault();
    endpoint = startFakeEndpoint();
    const graceId = await seedSubject(
      setup.vault,
      "person:grace",
      "grace",
      "Grace",
      "Grace mentioned she now runs partnerships at Acme.",
    );
    const tomId = await seedSubject(
      setup.vault,
      "person:tom",
      "tom",
      "Tom",
      "Tom said he is based in Lisbon these days.",
    );
    endpoint.reply = extractReply([
      claimFor(graceId, "person:grace", "Grace leads partnerships at Acme."),
      claimFor(tomId, "person:tom", "Tom works remotely from Lisbon."),
    ]);
    writeServeToml(
      setup.vault,
      {
        id: "kizuki.llm.openai-compatible",
        base_url: endpoint.base_url,
        model: "test-model",
        secret_ref: `env:${MODEL_KEY_ENV}`,
        max_retries: 0,
      },
      { canon_writes_per_run: 1 },
    );
    const env = { ...setup.env, [MODEL_KEY_ENV]: MODEL_KEY_VALUE };

    const result = await runCliLive(env, "serve", "run", "sync", "--json");
    expect(result.exitCode).toBe(0);
    const receipt = data<{ canon_writes: number; stopped: string | null; status: string }>(
      result.stdout,
    );
    expect(receipt.canon_writes).toBe(1);
    // The plan named this `budget_exhausted`; the run receipt's actual field
    // is `stopped`, and `BudgetExhausted` (packages/core/src/canon/budget.ts)
    // stamps it `budget:<which limit>`, never the bare word `budget_exhausted`.
    expect(receipt.stopped).toBe("budget:canon_writes_per_run");
    expect(receipt.status).toBe("stopped");
  });

  test("4.7 the model being down is not the same as nothing to extract", async () => {
    const setup = tempVault();
    endpoint = startFakeEndpoint(unavailableReply);
    const eventId = await seedSubject(
      setup.vault,
      "person:grace",
      "grace",
      "Grace",
      "Grace mentioned she now runs partnerships at Acme.",
    );
    writeServeToml(setup.vault, {
      id: "kizuki.llm.openai-compatible",
      base_url: endpoint.base_url,
      model: "test-model",
      secret_ref: `env:${MODEL_KEY_ENV}`,
      max_retries: 0,
    });
    const env = { ...setup.env, [MODEL_KEY_ENV]: MODEL_KEY_VALUE };

    const down = await runCliLive(env, "serve", "run", "sync", "--json");
    expect(down.exitCode).toBe(0);
    const downReceipt = data<{ canon_writes: number; stopped: string | null }>(down.stdout);
    // The deterministic entity claim seeded above still gets written — a
    // configured-but-down model degrades extraction, not the receipted
    // writer's floor. Only the model-attributed write is blocked here.
    expect(downReceipt.canon_writes).toBe(1);
    expect(downReceipt.stopped).toContain("unavailable");
    const beforeRows = auditRows(env);
    expect(beforeRows.some((row) => row.model_ref !== null)).toBe(false);

    // The extraction checkpoint must not have advanced past the event the
    // down call never got to look at: once the model comes back, the same
    // event is still there to mine and write.
    if (endpoint !== null) {
      endpoint.reply = extractReply([
        claimFor(eventId, "person:grace", "Grace leads partnerships at Acme."),
      ]);
    }
    const recovered = await runCliLive(env, "serve", "run", "sync", "--json");
    expect(recovered.exitCode).toBe(0);
    const recoveredReceipt = data<{ canon_writes: number }>(recovered.stdout);
    expect(recoveredReceipt.canon_writes).toBe(1);
    const afterRows = auditRows(env);
    expect(afterRows.some((row) => row.model_ref !== null)).toBe(true);
  });
});

// 4.8 (`deploy/proof/container.sh --with-model`) is out of scope for this
// worktree: `deploy/` does not exist on this branch. See the lane handoff.
