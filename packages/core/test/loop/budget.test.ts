import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClaim } from "../../src/claims/store";
import type { ProduceResult, ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import {
  EXTRACT_INPUT_CHARS,
  createModelProducerPort,
  MODEL_PRODUCER_DESCRIPTOR,
} from "../../src/producer/model";
import { listRunReceipts } from "../../src/serve/receipts";
import { runRail } from "../../src/serve/rails";
import { fileProposal } from "../../src/staging/proposals";
import { initVault } from "../../src/vault/init";
import { putEvent } from "../claims/helpers";
import {
  GRACE_EVENT,
  TOM_EVENT,
  draft,
  input,
  responseText,
  scriptedLlm,
  temporaryProducerContext,
} from "../producer/helpers";

const dirs: string[] = [];
const NOW = "2026-08-28T12:00:00.000Z";

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function stubProducer(result: ProduceResult): ProducerPort {
  return {
    descriptor: {
      id: "kizuki.producer.fixture",
      kind: "producer",
      contract: "kizuki.producer/v1",
      contract_minor: 1,
      supports: ["model"],
      requires_lease: false,
      optional_package: null,
    },
    health: async () => ({ status: "ready", detail: {} }),
    close: async () => undefined,
    produce: async () => result,
  };
}

function vault(budgetToml: string) {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-loop-budget-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  writeFileSync(join(path, ".kizuki", "serve.toml"), budgetToml);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  return { path, db };
}

function filePerson(
  db: ReturnType<typeof openLedger>,
  eventId: string,
  name: "grace" | "ada",
) {
  const title = name === "grace" ? "Grace" : "Ada";
  const filed = fileProposal(db, {
    kind: "claim",
    target: `people/${name}`,
    body: `${title} works at Acme.`,
    frontmatter: { type: "person", title },
    provenance: [eventId],
    subjects: [`person:${name}`],
    producer: "deterministic",
    confidence: 0.8,
  });
  if (filed.outcome !== "stored") throw new Error("expected stored claim");
  return filed.proposal.proposal_id;
}

function writeHooks(db: ReturnType<typeof openLedger>) {
  return {
    model_ref: "kizuki.llm.openai-compatible:synthetic@local",
    producer: stubProducer({
      status: "ok" as const,
      claims: [],
      usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
      dropped: [],
    }),
    claims: { db },
  };
}

test("the per-run canon write ceiling stops the pass cleanly at a checkpoint", async () => {
  const { path, db } = vault("[budget]\ncanon_writes_per_run = 1\n");
  const firstId = filePerson(db, putEvent(db, { source_record_id: "budget-grace" }), "grace");
  const secondId = filePerson(db, putEvent(db, { source_record_id: "budget-ada" }), "ada");

  const receipt = await runRail(db, path, "sync", {
    now: () => NOW,
    hooks: writeHooks(db),
  });

  expect(receipt.canon_writes).toBe(1);
  expect(receipt.stopped).toBe("budget:canon_writes_per_run");
  expect(existsSync(join(path, "auto", "people", "grace.md"))).toBe(true);
  expect(existsSync(join(path, "auto", "people", "ada.md"))).toBe(false);
  expect(getClaim(db, firstId)?.receipt_id).toBeString();
  expect(getClaim(db, secondId)?.status).toBe("live");
  expect(getClaim(db, secondId)?.receipt_id).toBeNull();
  db.close();
});

test("the per-day ceiling survives a restart", async () => {
  const { path, db } = vault(
    "[budget]\ncanon_writes_per_run = 8\ncanon_writes_per_day = 1\n",
  );
  filePerson(db, putEvent(db, { source_record_id: "budget-day-grace" }), "grace");
  filePerson(db, putEvent(db, { source_record_id: "budget-day-ada" }), "ada");

  const first = await runRail(db, path, "sync", {
    now: () => NOW,
    hooks: writeHooks(db),
  });
  expect(first.canon_writes).toBe(1);
  expect(first.stopped).toBe("budget:canon_writes_per_day");
  db.close();

  const reopened = openLedger(join(path, ".kizuki", "kizuki.db"));
  const second = await runRail(reopened, path, "sync", {
    now: () => "2026-08-28T18:00:00.000Z",
    hooks: writeHooks(reopened),
  });
  expect(second.canon_writes).toBe(0);
  expect(second.stopped).toBe("budget:canon_writes_per_day");
  expect(existsSync(join(path, "auto", "people", "ada.md"))).toBe(false);
  reopened.close();
});

test("a stopped run records stopped as budget:<name> and resumes next pass", async () => {
  const { path, db } = vault("[budget]\ncanon_writes_per_run = 1\n");
  const firstId = filePerson(db, putEvent(db, { source_record_id: "budget-resume-grace" }), "grace");
  const secondId = filePerson(db, putEvent(db, { source_record_id: "budget-resume-ada" }), "ada");

  const stopped = await runRail(db, path, "sync", {
    now: () => NOW,
    hooks: writeHooks(db),
  });
  expect(stopped.stopped).toBe("budget:canon_writes_per_run");
  expect(listRunReceipts(db).some((row) => row.stopped === "budget:canon_writes_per_run")).toBe(
    true,
  );
  const firstReceipt = getClaim(db, firstId)?.receipt_id;
  expect(firstReceipt).toBeString();

  const resumed = await runRail(db, path, "sync", {
    now: () => "2026-08-28T12:00:01.000Z",
    hooks: writeHooks(db),
  });
  expect(resumed.canon_writes).toBe(1);
  expect(resumed.stopped).toBeNull();
  expect(existsSync(join(path, "auto", "people", "ada.md"))).toBe(true);
  expect(getClaim(db, secondId)?.receipt_id).toBeString();
  expect(getClaim(db, firstId)?.receipt_id).toBe(firstReceipt);
  db.close();
});

test("token and call budgets are charged before the request, not after", async () => {
  async function refuse(budget: Partial<ReturnType<typeof input>["budget"]>, events = [GRACE_EVENT]) {
    const temporary = temporaryProducerContext(MODEL_PRODUCER_DESCRIPTOR);
    const llm = scriptedLlm(() => responseText([draft()]));
    const producer = createModelProducerPort(temporary.ctx, { llm });
    try {
      const result = await producer.produce(input(events, budget));
      expect(result).toMatchObject({
        status: "rejected",
        reason: "budget_exhausted",
        usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
        diagnostic: { stage: "budget", used: 0 },
      });
      expect(llm.requests).toHaveLength(0);
      return result;
    } finally {
      await producer.close();
      temporary.cleanup();
    }
  }

  const calls = await refuse(
    { max_calls: 1 },
    [GRACE_EVENT, { ...TOM_EVENT, text: "z".repeat(EXTRACT_INPUT_CHARS) }],
  );
  expect(calls).toMatchObject({ diagnostic: { rule: "max_calls", requested: 2, limit: 1 } });

  const tokens = await refuse({ max_input_tokens: 10 });
  expect(tokens).toMatchObject({ diagnostic: { rule: "max_input_tokens", limit: 10 } });
  if (tokens.status === "rejected" && tokens.diagnostic?.stage === "budget") {
    expect(tokens.diagnostic.requested).toBeGreaterThan(10);
  }

  const output = await refuse({ max_output_tokens: 0 });
  expect(output).toMatchObject({ diagnostic: { rule: "max_output_tokens", limit: 0 } });

  const later = await refuse(
    { max_calls: 2, max_input_tokens: 8_000, max_output_tokens: 20_000 },
    [
      { ...GRACE_EVENT, text: "g".repeat(16_000) },
      { ...TOM_EVENT, text: "t".repeat(16_000) },
    ],
  );
  expect(later).toMatchObject({ diagnostic: { rule: "max_input_tokens", limit: 8_000 } });
  if (later.status === "rejected" && later.diagnostic?.stage === "budget") {
    expect(later.diagnostic.requested).toBeGreaterThan(8_000);
  }
});
