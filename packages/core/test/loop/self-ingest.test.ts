import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyCanonWrite } from "../../src/canon/apply";
import { createBudgetTracker } from "../../src/canon/budget";
import { resolveTarget, type TargetDecision } from "../../src/canon/arbiter";
import { countClaims, getClaim, insertClaim } from "../../src/claims/store";
import { recordNativeCorrection } from "../../src/correction/evidence";
import { openLedger } from "../../src/ledger/db";
import { commitMachineByteIntent } from "../../src/ledger/event-origin";
import { accept, readSince } from "../../src/ledger/ledger";
import { sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";
import { initVault } from "../../src/vault/init";
import type { Producer } from "../../src/contracts/proposal";
import { eventFacts, FixtureVectorPort, putEvent } from "../claims/helpers";
import { validEvent } from "../fixtures";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-loop-self-"));
  roots.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  return { root, vault, db: openLedger(join(vault, ".kizuki", "kizuki.db")) };
}

async function storedClaim(
  db: ReturnType<typeof openLedger>, eventId: string, producer: Producer = "deterministic",
  overrides: Record<string, unknown> = {},
) {
  const result = await insertClaim({ db }, {
    kind: "claim", target: "people/grace", subject: "person:grace", predicate: "employment.works_at",
    object: "acme", polarity: "positive", body: "Grace runs partnerships at Acme.",
    frontmatter: { type: "person", title: "Grace" }, provenance: [eventId], subjects: ["person:grace"],
    producer, confidence: 0.8, sensitivity: "personal", taint: "clean", events: [eventFacts(eventId)], ...overrides,
  });
  if (result.outcome !== "stored") throw new Error(`fixture claim was ${result.outcome}`);
  return result.claim;
}

function targetPath(target: TargetDecision): string {
  if (!("rel_path" in target)) throw new Error("fixture did not resolve a writable target");
  return target.rel_path;
}

function writeLoop(db: ReturnType<typeof openLedger>, vault: string, claim: Awaited<ReturnType<typeof storedClaim>>, relPath?: string) {
  const decision = relPath === undefined ? resolveTarget({ db, vault_path: vault }, claim) : {
    action: "create" as const, rel_path: relPath,
  };
  return applyCanonWrite({ db, vault_path: vault }, claim, decision, {
    writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
  });
}

function byteIntent(db: ReturnType<typeof openLedger>, text: string): void {
  commitMachineByteIntent(db, { receipt_id: ulid(), before_hash: null, after_hash: sha256Hex(text) }, () => undefined);
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("synthetic process deadline exceeded")), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

test("exact loop postimage bytes are self, while empty and unrelated external bytes are not", async () => {
  const { db, vault } = fixture();
  try {
    const source = putEvent(db);
    const receipt = writeLoop(db, vault, await storedClaim(db, source));
    const bytes = readFileSync(join(vault, receipt.page_path), "utf8");
    const copied = accept(db, { ...validEvent(), connector_id: "forged.owner.label", source_record_id: "copied-machine-bytes", text: bytes });
    expect(copied).toMatchObject({ status: "stored", event: { origin: "self" } });
    expect(accept(db, { ...validEvent(), source_record_id: "changed-byte", text: `${bytes}x` }))
      .toMatchObject({ status: "stored", event: { origin: "external" } });
    expect(accept(db, { ...validEvent(), source_record_id: "empty-external", text: "" })).toMatchObject({ status: "stored", event: { origin: "external" } });
    expect(accept(db, { ...validEvent(), source_record_id: "ordinary-external", text: "ordinary captured text" })).toMatchObject({ status: "stored", event: { origin: "external" } });
  } finally { db.close(); }
});

test("only native correction proof exempts matching bytes from self classification", async () => {
  const { db, vault } = fixture();
  try {
    const source = putEvent(db);
    const receipt = writeLoop(db, vault, await storedClaim(db, source));
    const bytes = readFileSync(join(vault, receipt.page_path), "utf8");
    const recorded = recordNativeCorrection(db, {
      ...validEvent(), connector_id: "kizuki.owner", source_record_id: "native-correction-machine-copy",
      kind: "correction", text: bytes, metadata: {},
    }, sha256Hex("native-correction-machine-copy"));
    expect(readSince(db, null, 20).events.find(event => event.event_id === recorded.event_id)).toMatchObject({ origin: "external" });
  } finally { db.close(); }
});

test("an archived loop preimage is marked self before a copied byte can re-enter", async () => {
  const { db, vault } = fixture();
  try {
    const claim = await storedClaim(db, putEvent(db));
    const created = writeLoop(db, vault, claim);
    const revised = writeLoop(db, vault, await storedClaim(db, putEvent(db, { source_record_id: "archive-revision" }), "deterministic", {
      predicate: "contact.email", object: "grace@example.invalid", body: "Grace can be reached at grace@example.invalid.",
    }));
    expect(revised.archive_path).not.toBeNull();
    const priorBytes = readFileSync(join(vault, revised.archive_path!), "utf8");
    expect(accept(db, {
      ...validEvent(), connector_id: "forged.owner.label", source_record_id: "copied-loop-preimage", text: priorBytes,
    })).toMatchObject({ status: "stored", event: { origin: "self" } });
    expect(created.before_hash).toBeNull();
  } finally { db.close(); }
});

test("the public writer preserves a model claim admitted before a later matching intent", async () => {
  const { db, vault } = fixture();
  try {
    const eventId = putEvent(db, { source_record_id: "model-later-self" });
    const claim = await storedClaim(db, eventId, "model");
    byteIntent(db, "Grace runs partnerships at Acme.");
    const target = resolveTarget({ db, vault_path: vault }, claim);
    expect(() => applyCanonWrite({ db, vault_path: vault }, claim, target, {
      writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
    })).not.toThrow();
    expect(existsSync(join(vault, targetPath(target)))).toBe(true);
  } finally { db.close(); }
});

test("a later intent during retrieval cannot restamp evidence or suppress legitimate corroboration", async () => {
  const { db } = fixture();
  let entered!: () => void;
  let release!: () => void;
  const queried = new Promise<void>((resolve) => { entered = resolve; });
  const continueQuery = new Promise<void>((resolve) => { release = resolve; });
  class AwaitingRetrieval extends FixtureVectorPort {
    override async search(query: Parameters<FixtureVectorPort["search"]>[0]) {
      entered();
      await continueQuery;
      return super.search(query);
    }
  }
  try {
    const independent = await storedClaim(db, putEvent(db, { source_record_id: "independent-existing", text: "independent external evidence" }), "model");
    const eventId = putEvent(db, { source_record_id: "async-self-race", text: "race bytes" });
    const filing = insertClaim({ db, retrieval: new AwaitingRetrieval() }, {
      kind: "claim", target: "people/grace", subject: "person:grace", predicate: "employment.works_at",
      object: "acme", polarity: "positive", body: "Grace works with Acme partnerships.",
      frontmatter: { type: "person", title: "Grace" }, provenance: [eventId], subjects: ["person:grace"],
      producer: "model", confidence: 0.8, sensitivity: "personal", taint: "clean", events: [eventFacts(eventId, { text: "race bytes" })],
    });
    await within(queried);
    byteIntent(db, "race bytes");
    release();
    expect((await filing).outcome).toBe("duplicate");
    expect(countClaims(db)).toBe(1);
    expect(getClaim(db, independent.claim_id)?.corroboration).toBe(2);
  } finally { release(); db.close(); }
});

test.each(["before publication", "after publication"] as const)("a second process sees the durable byte intent %s and a killed writer retains it", async (phase) => {
  const { vault, db } = fixture();
  db.close();
  const repo = process.cwd();
  const child = Bun.spawn([process.execPath, "-e", `
    import { existsSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    import { openLedger } from ${JSON.stringify(join(repo, "packages/core/src/ledger/db.ts"))};
    import { accept } from ${JSON.stringify(join(repo, "packages/core/src/ledger/ledger.ts"))};
    import { insertClaim } from ${JSON.stringify(join(repo, "packages/core/src/claims/store.ts"))};
    import { applyCanonWrite } from ${JSON.stringify(join(repo, "packages/core/src/canon/apply.ts"))};
    import { createBudgetTracker } from ${JSON.stringify(join(repo, "packages/core/src/canon/budget.ts"))};
    const vault = ${JSON.stringify(vault)}, db = openLedger(join(vault, ".kizuki/kizuki.db"));
    if (${JSON.stringify(phase)} === "before publication") {
      const transaction = db.transaction.bind(db);
      db.transaction = (...args) => {
        const tx = transaction(...args);
        const wrapped = (...values) => tx(...values);
        wrapped.deferred = tx.deferred; wrapped.exclusive = tx.exclusive;
        wrapped.immediate = (...values) => {
          const result = tx.immediate(...values);
          if (!existsSync(join(vault, "people/grace.md")) && db.query("SELECT 1 FROM canon_machine_byte_intents").get() !== null) {
            console.log("intent-committed"); readFileSync(0,"utf8");
          }
          return result;
        };
        return wrapped;
      };
    }
    const event = {schema:"kizuki.event/v1",connector_id:"fixture",source_record_id:"two-process-source",kind:"message",occurred_at:"2026-02-28T10:30:00Z",observed_at:"2026-03-01T00:00:00Z",text:"Synthetic external evidence.",subjects:[{subject_id:"person:grace",role:"from"}],sensitivity_hint:"personal",deleted:false,attachments:[],metadata:{}};
    const accepted = accept(db, event); if (accepted.status !== "stored") throw Error("event not stored");
    const filed = await insertClaim({db}, {kind:"claim",target:"people/grace",subject:"person:grace",predicate:"employment.works_at",object:"acme",polarity:"positive",body:"Grace runs partnerships at Acme.",frontmatter:{type:"person",title:"Grace"},provenance:[accepted.event.event_id],subjects:["person:grace"],producer:"deterministic",confidence:.8,sensitivity:"personal",taint:"clean",events:[{event_id:accepted.event.event_id,connector_id:"fixture",taint:"untrusted",text:event.text}]});
    if (filed.outcome !== "stored") throw Error("claim not stored");
    applyCanonWrite({db,vault_path:vault,now:()=>{ console.log("page-written"); readFileSync(0,"utf8"); return "2026-09-05T00:00:00.000Z";}}, filed.claim, {action:"create",rel_path:"people/grace.md"}, {writer:"loop",budget:createBudgetTracker({canon_writes_per_run:1})});
  `], { cwd: repo, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  try {
    const ready = await within(reader.read());
    expect(new TextDecoder().decode(ready.value)).toContain(phase === "before publication" ? "intent-committed" : "page-written");
    const parent = openLedger(join(vault, ".kizuki", "kizuki.db"));
    try {
      if (phase === "after publication") {
        const bytes = readFileSync(join(vault, "people/grace.md"), "utf8");
        expect(accept(parent, { ...validEvent(), source_record_id: "two-process-copy", text: bytes }))
          .toMatchObject({ status: "stored", event: { origin: "self" } });
      } else expect(existsSync(join(vault, "people/grace.md"))).toBe(false);
      expect(parent.query("SELECT 1 FROM canon_receipts").get()).toBeNull();
      expect(parent.query("SELECT 1 FROM canon_machine_byte_intents").get()).not.toBeNull();
    } finally { parent.close(); }
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await reader.cancel();
    await new Response(child.stderr).text();
  }
  const recovered = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    expect(recovered.query("SELECT 1 FROM canon_receipts").get()).toBeNull();
    expect(recovered.query("SELECT 1 FROM canon_machine_byte_intents").get()).not.toBeNull();
  } finally { recovered.close(); }
});

test("a failed loop write retains its byte intent and nested admission is rejected before bytes change", async () => {
  const { db, vault } = fixture();
  try {
    const source = putEvent(db);
    const claim = await storedClaim(db, source);
    symlinkSync(join(vault, "missing-page"), join(vault, "blocked.md"));
    expect(() => writeLoop(db, vault, claim, "blocked.md")).toThrow(/symlink/i);
    expect(db.query("SELECT receipt_id FROM canon_machine_byte_intents").all()).toHaveLength(1);
    expect(existsSync(join(vault, "blocked.md"))).toBe(false);

    const target = resolveTarget({ db, vault_path: vault }, claim);
    expect(() => db.transaction(() => applyCanonWrite({ db, vault_path: vault }, claim, target, {
      writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
    }))()).toThrow("top-level transaction");
    expect(existsSync(join(vault, targetPath(target)))).toBe(false);
  } finally { db.close(); }
});

test("a capture waiting on an earlier intent transaction stores self after that intent commits", async () => {
  const { vault, db } = fixture();
  db.close();
  const path = join(vault, ".kizuki", "kizuki.db");
  const imports = `
    import { readSync } from 'node:fs';
    import { openLedger } from ${JSON.stringify(join(process.cwd(), "packages/core/src/ledger/db.ts"))};
    import { accept } from ${JSON.stringify(join(process.cwd(), "packages/core/src/ledger/ledger.ts"))};
    import { commitMachineByteIntent } from ${JSON.stringify(join(process.cwd(), "packages/core/src/ledger/event-origin.ts"))};
    const db = openLedger(${JSON.stringify(path)});
    db.exec('PRAGMA busy_timeout=5000');
    const waitForParent = () => readSync(0, Buffer.alloc(1), 0, 1, null);
  `;
  const input = { ...validEvent(), source_record_id: "waiting-capture", text: "transaction ordered machine bytes" };
  const capture = Bun.spawn([process.execPath, "-e", `${imports}
    console.log('capture-ready'); waitForParent(); console.log('capture-admitting');
    const result = accept(db, ${JSON.stringify(input)});
    console.log(JSON.stringify({status:result.status,origin:result.status==='stored'?result.event.origin:null}));
    db.close();
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const captureOutput = capture.stdout.getReader();
  let holder: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const ready = await within(captureOutput.read());
    expect(new TextDecoder().decode(ready.value)).toContain("capture-ready");
    holder = Bun.spawn([process.execPath, "-e", `${imports}
      commitMachineByteIntent(db, ${JSON.stringify({ receipt_id: ulid(), before_hash: null, after_hash: sha256Hex(input.text) })}, () => {
        console.log('intent-locked'); waitForParent();
      });
      db.close();
    `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const holderOutput = (holder.stdout as ReadableStream<Uint8Array>).getReader();
    const locked = await within(holderOutput.read());
    expect(new TextDecoder().decode(locked.value)).toContain("intent-locked");
    capture.stdin.write("g");
    await capture.stdin.flush();
    const admitting = await within(captureOutput.read());
    expect(new TextDecoder().decode(admitting.value)).toContain("capture-admitting");
    let captured = false;
    const outcome = captureOutput.read().then(value => { captured = true; return value; });
    await Bun.sleep(50);
    expect(captured).toBe(false);
    (holder.stdin as import("bun").FileSink).write("g");
    await (holder.stdin as import("bun").FileSink).flush();
    const result = await within(outcome);
    expect(JSON.parse(new TextDecoder().decode(result.value))).toEqual({ status: "stored", origin: "self" });
    expect(await within(capture.exited)).toBe(0);
    expect(await within(holder.exited)).toBe(0);
    holderOutput.releaseLock();
    const reopened = openLedger(path);
    try { expect(readSince(reopened, null, 1).events[0]?.origin).toBe("self"); }
    finally { reopened.close(); }
  } finally {
    capture.kill();
    holder?.kill();
    await capture.exited;
    if (holder !== undefined) await holder.exited;
    captureOutput.releaseLock();
  }
});
