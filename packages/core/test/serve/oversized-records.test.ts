import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import { listClaims } from "../../src/claims/store";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { escapeFenceText } from "../../src/producer/fence";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { journalExtractBatch, mineLiveDrafts, readExtractCursor, retrySkippedRecords } from "../../src/serve/extract";
import { listSkippedRecords, segmentEnd } from "../../src/serve/extract-oversized";
import { runRail } from "../../src/serve/rails";
import { DEFAULT_EXTRACTION_CONFIG } from "../../src/serve/types";
import { runWritePass } from "../../src/serve/write-pass";
import { withVaultMutationSync } from "../../src/vault/mutation-scope";
import {
  MODEL,
  paragraphRecord,
  recordText,
  segmentModelProducer,
  throughputVault,
  writeServeToml,
  type QuotedRequest,
} from "./throughput-fixture";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

const SETTINGS = "[extraction]\nmax_calls_per_pass = 12\nrecords_per_request = 4\nmax_input_tokens = 16000\nmax_output_tokens = 16384\n";
const SIXTY_K = paragraphRecord(60_000);

function vaultWith(texts: readonly string[], settings = SETTINGS) {
  const vault = throughputVault(texts.length, (index) => texts[index]!);
  const db = openLedger(vault.ledger);
  disposers.push(vault.dispose, () => db.close());
  writeServeToml(vault.vault, settings);
  return { ...vault, db };
}

const sync = (f: { db: Database; vault: string }, producer: ReturnType<typeof segmentModelProducer>["producer"]) =>
  runRail(f.db, f.vault, "sync", { hooks: { producer, claims: { db: f.db }, model_ref: MODEL } });
const endsAt = (cursor: string | null, eventId: string): boolean => cursor?.endsWith(`\t${eventId}`) === true;
const modelClaims = (db: Database): number =>
  listClaims(db, { status: "live", limit: 1_000 }).filter((claim) => claim.producer === "model").length;
/** Every filed typed anchor citing `eventId`, in record order. */
function anchorsOf(db: Database, eventId: string): { start_utf16: number; end_utf16: number }[] {
  return db.query<{ anchors: string }, []>("SELECT anchors FROM claim_v2_support").all()
    .flatMap((row) => JSON.parse(row.anchors) as { event_id: string; start_utf16: number; end_utf16: number }[])
    .filter((anchor) => anchor.event_id === eventId)
    .sort((left, right) => left.start_utf16 - right.start_utf16);
}
const oversizedRows = (db: Database) => db.query("SELECT * FROM extract_oversized_records ORDER BY event_id").all();
const segmentsOf = (requests: readonly QuotedRequest[], eventId: string): string[] =>
  requests.filter((request) => request.event_ids.length === 1 && request.event_ids[0] === eventId).map((request) => request.texts[0]!);

describe("segment boundaries", () => {
  test("prefer a paragraph break, then a line break, then a word boundary in the window's second half", () => {
    const paragraphs = `${"alpha ".repeat(10)}\n\n${"beta ".repeat(10)}\n${"gamma ".repeat(10)}`;
    const paragraphEnd = paragraphs.indexOf("\n\n") + 2;
    expect(segmentEnd(paragraphs, 0, paragraphEnd + 40)).toBe(paragraphEnd);
    // A paragraph break in the first half loses to a later line break.
    const lineEnd = paragraphs.indexOf("\ngamma") + 1;
    expect(segmentEnd(paragraphs, 0, lineEnd + 20)).toBe(lineEnd);
    const words = "delta ".repeat(100);
    const end = segmentEnd(words, 0, 100)!;
    expect(end).toBeLessThanOrEqual(100);
    expect(end).toBeGreaterThan(50);
    expect(/^(?:delta ?)+$/.test(words.slice(0, end))).toBe(true);
    expect([" ", "d"]).toContain(words[end]!);
    expect(segmentEnd(words, 0, 1_000)).toBe(words.length);
    expect(segmentEnd(words, 590, 100)).toBe(words.length);
  });

  test("never split a surrogate pair, a grapheme or a fence look-alike, and fit the escaped limit", () => {
    const emoji = "\u{1F600}".repeat(20_000);
    const end = segmentEnd(emoji, 0, 24_001)!;
    expect(end % 2).toBe(0);
    expect(end).toBeLessThanOrEqual(24_001);
    const accents = "é ".repeat(100);
    for (let limit = 10; limit < 40; limit++) {
      const at = segmentEnd(accents, 0, limit)!;
      expect(accents[at]).not.toBe("́");
    }
    const fenced = "note <<<KZ-QUOTE ".repeat(40);
    const lookalikes = [...fenced.matchAll(/<<<KZ-/g)].map((match) => match.index);
    for (let limit = 20; limit < 200; limit++) {
      const at = segmentEnd(fenced, 0, limit)!;
      expect(escapeFenceText(fenced.slice(0, at)).length).toBeLessThanOrEqual(limit);
      expect(lookalikes.filter((index) => index < at && at < index + 6)).toEqual([]);
      expect(escapeFenceText(fenced.slice(0, at)) + escapeFenceText(fenced.slice(at))).toBe(escapeFenceText(fenced));
    }
  });

  test("a single token longer than the window has no safe split", () => {
    expect(segmentEnd("k".repeat(30_000), 0, 24_000)).toBeNull();
    expect(segmentEnd(`lead ${"k".repeat(30_000)}`, 5, 24_000)).toBeNull();
  });
});

test("a 60k-character record is extracted in three segments whose anchors validate against the original text", async () => {
  const f = vaultWith([recordText(0), SIXTY_K, recordText(2)]);
  const [e0, e1, e2] = f.eventIds as [string, string, string];
  const model = segmentModelProducer(f.vault);
  const receipt = await sync(f, model.producer);
  expect(receipt).toMatchObject({ status: "ok", stopped: null, errors: [], claims_extracted: 5, model: { calls: 5 },
    oversized: { segments: 3, skipped: 0 } });
  // The record under the limit keeps its own request; the oversized one never shares one.
  expect(model.requests.map((request) => request.event_ids)).toEqual([[e0], [e1], [e1], [e1], [e2]]);
  const segments = segmentsOf(model.requests, e1);
  expect(segments).toHaveLength(3);
  expect(segments.join("")).toBe(SIXTY_K);
  for (const segment of segments) expect(escapeFenceText(segment).length).toBeLessThanOrEqual(24_000);
  for (const segment of segments.slice(0, 2)) expect(segment.endsWith("\n\n")).toBe(true);
  // Anchors are record offsets: each quotes the label that opened its segment in the original text.
  const starts = [0, segments[0]!.length, segments[0]!.length + segments[1]!.length];
  const anchors = anchorsOf(f.db, e1);
  expect(anchors.map((anchor) => anchor.start_utf16)).toEqual(starts);
  for (const anchor of anchors) {
    expect(SIXTY_K.slice(anchor.start_utf16, anchor.end_utf16)).toMatch(/^Paragraph \d{4}$/);
    expect(SIXTY_K.slice(anchor.start_utf16, anchor.end_utf16)).toBe(/Paragraph \d{4}/.exec(SIXTY_K.slice(anchor.start_utf16))![0]);
  }
  const occurrences = f.db.query<{ start_utf16: number; end_utf16: number }, [string]>(
    "SELECT start_utf16,end_utf16 FROM claim_occurrences WHERE event_id=? ORDER BY start_utf16").all(e1);
  expect(occurrences).toEqual(anchors.map(({ start_utf16, end_utf16 }) => ({ start_utf16, end_utf16 })));
  expect(endsAt(readExtractCursor(f.db), e2)).toBe(true);
  expect(modelClaims(f.db)).toBe(5);
  expect(oversizedRows(f.db)).toEqual([]);
  expect(f.db.query("SELECT 1 FROM extract_batches").all()).toEqual([]);
});

test("a segment shrinks to what max_input_tokens can carry", async () => {
  const f = vaultWith([SIXTY_K], "[extraction]\nmax_calls_per_pass = 32\nmax_input_tokens = 4000\n");
  const [e0] = f.eventIds as [string];
  const model = segmentModelProducer(f.vault);
  const receipt = await sync(f, model.producer);
  const segments = segmentsOf(model.requests, e0);
  expect(segments.join("")).toBe(SIXTY_K);
  expect(segments.length).toBeGreaterThan(6);
  expect(receipt).toMatchObject({ status: "ok", errors: [], oversized: { segments: segments.length, skipped: 0 } });
  expect(anchorsOf(f.db, e0)).toHaveLength(segments.length);
  expect(endsAt(readExtractCursor(f.db), e0)).toBe(true);
});

test("each segment is one pass step: a stop request ends the pass between segments and the next pass resumes", async () => {
  const f = vaultWith([SIXTY_K, recordText(1)]);
  const [e0, e1] = f.eventIds as [string, string];
  const model = segmentModelProducer(f.vault);
  const stopped = await runWritePass(f.db, f.vault, {
    budget: createBudgetTracker({ canon_writes_per_run: 0 }),
    producer: model.producer,
    claims: { db: f.db },
    model_ref: MODEL,
    extraction: { ...DEFAULT_EXTRACTION_CONFIG, max_calls_per_pass: 12, records_per_request: 4, max_input_tokens: 16_000, max_output_tokens: 16_384 },
    stopRequested: () => model.requests.length >= 1,
  });
  expect(model.requests.map((request) => request.event_ids)).toEqual([[e0]]);
  expect(stopped).toMatchObject({ stopped: "serve:stop_requested", claims_extracted: 1, canon_writes: 0,
    oversized: { segments: 1, skipped: 0 } });
  // The first segment is filed and the cursor stays before its record.
  expect(readExtractCursor(f.db)).toBeNull();
  const first = model.requests[0]!.texts[0]!;
  expect(oversizedRows(f.db)).toMatchObject([{ event_id: e0, status: "segmenting", chars: 60_000, done_utf16: first.length, pending_end_utf16: null }]);

  const resumed = await sync(f, model.producer);
  expect(model.requests.map((request) => request.event_ids)).toEqual([[e0], [e0], [e0], [e1]]);
  expect(segmentsOf(model.requests, e0).join("")).toBe(SIXTY_K);
  expect(resumed).toMatchObject({ status: "ok", stopped: null, errors: [], claims_extracted: 3, oversized: { segments: 2, skipped: 0 } });
  expect(anchorsOf(f.db, e0)).toHaveLength(3);
  expect(endsAt(readExtractCursor(f.db), e1)).toBe(true);
  expect(oversizedRows(f.db)).toEqual([]);
});

test("the writer is free while a segment request is in flight", async () => {
  const f = vaultWith([SIXTY_K]);
  const owner: string[] = [];
  // An owner correction, undo or purge takes the writer while each segment is asked.
  const model = segmentModelProducer(f.vault, () => {
    owner.push(withVaultMutationSync({ vault_path: f.vault, db: f.db }, () => "held"));
  });
  const receipt = await sync(f, model.producer);
  expect(owner).toEqual(["held", "held", "held"]);
  expect(receipt).toMatchObject({ status: "ok", stopped: null, errors: [], claims_extracted: 3, oversized: { segments: 3, skipped: 0 } });
});

test("a segment rejected on its own twice is skipped with a receipt at its offset, and retry-skipped resumes there", async () => {
  const f = vaultWith([SIXTY_K, recordText(1)]);
  const [e0, e1] = f.eventIds as [string, string];
  // The second segment is answered with a malformed completion both times it is asked.
  const model = segmentModelProducer(f.vault, (request) => (request === 2 || request === 3 ? "malformed" : undefined));
  const receipt = await sync(f, model.producer);
  expect(model.requests.map((request) => request.event_ids)).toEqual([[e0], [e0], [e0], [e1]]);
  const [first, second, again] = segmentsOf(model.requests, e0) as [string, string, string];
  expect(again).toBe(second);
  // The rejections are the pass's errors; the skip itself is the receipt, not a throughput skip.
  expect(receipt).toMatchObject({ status: "degraded", stopped: null, claims_extracted: 2, records_skipped: 0,
    claims_rejected: { schema_invalid: 2 }, model: { calls: 4 }, oversized: { segments: 1, skipped: 1 } });
  expect(receipt.errors.filter((error) => error.startsWith("record skipped"))).toEqual([]);
  expect(endsAt(readExtractCursor(f.db), e1)).toBe(true);
  expect(listSkippedRecords(f.db)).toEqual([{ reason: "record_oversized_skipped", event_id: e0, chars: 60_000,
    done_utf16: first.length, skipped_at: expect.any(String) }]);

  expect(retrySkippedRecords(f.db)).toBe(1);
  const retried = segmentModelProducer(f.vault);
  const resumed = await sync(f, retried.producer);
  expect(segmentsOf(retried.requests, e0).join("")).toBe(SIXTY_K.slice(first.length));
  expect(resumed).toMatchObject({ status: "ok", errors: [], oversized: { segments: 2, skipped: 0 } });
  expect(anchorsOf(f.db, e0).map((anchor) => anchor.start_utf16)).toEqual([0, first.length, expect.any(Number)]);
  expect(oversizedRows(f.db)).toEqual([]);
  expect(listSkippedRecords(f.db)).toEqual([]);
});

test("a kill between segments resumes at the next segment and never re-files a finished one", async () => {
  const f = vaultWith([recordText(0), SIXTY_K, recordText(2)]);
  const [e0, e1, e2] = f.eventIds as [string, string, string];
  const src = join(import.meta.dir, "../../src"), here = import.meta.dir;
  // Requests: e0, then the first segment, then the second segment is in flight when the process dies.
  const child = spawnSync(process.execPath, ["--eval", `
    import { openLedger } from ${JSON.stringify(join(src, "ledger/db.ts"))};
    import { runRail } from ${JSON.stringify(join(src, "serve/rails.ts"))};
    import { MODEL, segmentModelProducer } from ${JSON.stringify(join(here, "throughput-fixture.ts"))};
    const db = openLedger(${JSON.stringify(f.ledger)});
    const { producer } = segmentModelProducer(${JSON.stringify(f.vault)}, (request) => { if (request === 3) process.kill(process.pid, "SIGKILL"); });
    await runRail(db, ${JSON.stringify(f.vault)}, "sync", { hooks: { producer, claims: { db }, model_ref: MODEL } });
    process.exit(74);
  `], { encoding: "utf8", timeout: 60_000 });
  expect({ signal: child.signal, stderr: child.stderr }).toEqual({ signal: "SIGKILL", stderr: "" });

  f.db.close();
  const db = openLedger(f.ledger);
  disposers.push(() => db.close());
  expect(endsAt(readExtractCursor(db), e0)).toBe(true);
  const [progress] = oversizedRows(db) as { event_id: string; status: string; chars: number; done_utf16: number; pending_end_utf16: number | null }[];
  expect(progress).toMatchObject({ event_id: e1, status: "segmenting", chars: 60_000, pending_end_utf16: null });
  expect(anchorsOf(db, e1).map((anchor) => anchor.start_utf16)).toEqual([0]);
  expect(modelClaims(db)).toBe(2);

  const model = segmentModelProducer(f.vault);
  const resumed = await sync({ db, vault: f.vault }, model.producer);
  expect(resumed).toMatchObject({ status: "ok", errors: [], claims_extracted: 3, oversized: { segments: 2, skipped: 0 } });
  expect(model.requests.map((request) => request.event_ids)).toEqual([[e1], [e1], [e2]]);
  const rest = segmentsOf(model.requests, e1);
  expect(rest.join("")).toBe(SIXTY_K.slice(progress!.done_utf16));
  const anchors = anchorsOf(db, e1);
  expect(anchors.map((anchor) => anchor.start_utf16)).toEqual([0, progress!.done_utf16, progress!.done_utf16 + rest[0]!.length]);
  expect(modelClaims(db)).toBe(5);
  expect(endsAt(readExtractCursor(db), e2)).toBe(true);
  expect(oversizedRows(db)).toEqual([]);
}, 90_000);

test("a journaled segment decision replays after a restart without asking again", async () => {
  const f = vaultWith([SIXTY_K, recordText(1)]);
  const [e0, e1] = f.eventIds as [string, string];
  const first = segmentModelProducer(f.vault);
  const limits = { ...DEFAULT_EXTRACTION_CONFIG, max_input_tokens: 16_000, max_output_tokens: 16_384 };
  const mined = await mineLiveDrafts(f.db, first.producer, limits);
  expect(mined.mined).toEqual({ status: "ok", count: 1 });
  expect(mined.segment).toMatchObject({ event_id: e0, start: 0, chars: 60_000 });
  journalExtractBatch(f.db, mined, MODEL, first.producer);
  // The process dies after journaling, before filing.
  expect(oversizedRows(f.db)).toMatchObject([{ event_id: e0, done_utf16: 0, pending_end_utf16: mined.segment!.end }]);
  f.db.close();
  const db = openLedger(f.ledger);
  disposers.push(() => db.close());

  const model = segmentModelProducer(f.vault);
  const receipt = await sync({ db, vault: f.vault }, model.producer);
  expect(receipt).toMatchObject({ status: "ok", errors: [] });
  // The replay filed the first segment; the requests carry only the second and third.
  expect(model.requests.map((request) => request.event_ids)).toEqual([[e0], [e0], [e1]]);
  expect(segmentsOf(model.requests, e0).join("")).toBe(SIXTY_K.slice(mined.segment!.end));
  expect(anchorsOf(db, e0).map((anchor) => anchor.start_utf16)).toEqual([0, mined.segment!.end, expect.any(Number)]);
  expect(modelClaims(db)).toBe(4);
  expect(endsAt(readExtractCursor(db), e1)).toBe(true);
});

test("an unsplittable 30k single-token line is skipped with a receipt and the cursor moves on", async () => {
  const token = "k".repeat(30_000);
  const f = vaultWith([recordText(0), token, recordText(2)]);
  const [e0, e1, e2] = f.eventIds as [string, string, string];
  const model = segmentModelProducer(f.vault);
  const receipt = await sync(f, model.producer);
  expect(model.requests.map((request) => request.event_ids)).toEqual([[e0], [e2]]);
  expect(receipt).toMatchObject({ status: "ok", stopped: null, errors: [], claims_extracted: 2, model: { calls: 2 },
    oversized: { segments: 0, skipped: 1 } });
  expect(endsAt(readExtractCursor(f.db), e2)).toBe(true);
  const skipped = listSkippedRecords(f.db);
  expect(skipped).toEqual([{ reason: "record_oversized_skipped", event_id: e1, chars: 30_000, done_utf16: 0, skipped_at: expect.any(String) }]);
  // The receipt carries identity and size, never content.
  const stored = JSON.stringify(oversizedRows(f.db));
  expect(stored).not.toContain("kkkk");
  expect(Object.keys(oversizedRows(f.db)[0] as object).sort()).toEqual(["chars", "done_utf16", "event_id", "pending_end_utf16", "status", "updated_at"]);

  // Doctor shows the count and the command; retry re-queues the record and it is decided again.
  expect(inspectServeDoctor(f.db, f.vault).oversized).toEqual({ segmenting: 0, skipped: 1, retry: "kizuki serve retry-skipped",
    detail: "oversized records segmenting=0 skipped=1 retry: kizuki serve retry-skipped" });
  expect(retrySkippedRecords(f.db)).toBe(1);
  expect(retrySkippedRecords(f.db)).toBe(0);
  expect(f.db.query("SELECT event_id FROM extract_deferred_inputs").all()).toEqual([{ event_id: e1 }]);
  expect(inspectServeDoctor(f.db, f.vault).oversized).toEqual({ segmenting: 1, skipped: 0, retry: null,
    detail: "oversized records segmenting=1 skipped=0" });
  const again = await sync(f, model.producer);
  expect(again).toMatchObject({ status: "ok", errors: [], model: { calls: 0 }, oversized: { segments: 0, skipped: 1 } });
  expect(model.requests).toHaveLength(2);
  expect(f.db.query("SELECT event_id FROM extract_deferred_inputs").all()).toEqual([]);
  expect(listSkippedRecords(f.db).map((row) => row.event_id)).toEqual([e1]);
});

test("records under the limit keep today's whole requests and leave no segment state", async () => {
  const exact = paragraphRecord(24_000);
  const f = vaultWith([recordText(0), recordText(1), exact, recordText(3)]);
  const [e0, e1, e2, e3] = f.eventIds as [string, string, string, string];
  const model = segmentModelProducer(f.vault);
  const receipt = await sync(f, model.producer);
  // A request quotes at most 24,000 characters in all, so the full-size record travels alone and whole.
  expect(model.requests.map((request) => request.event_ids)).toEqual([[e0, e1], [e2], [e3]]);
  expect(model.requests[1]!.texts).toEqual([exact]);
  expect(receipt).toMatchObject({ status: "ok", errors: [], claims_extracted: 4, model: { calls: 3 } });
  expect(receipt.oversized).toBeUndefined();
  expect(oversizedRows(f.db)).toEqual([]);
});

test("a record without text is passed over without a request instead of refusing its request", async () => {
  const f = vaultWith([recordText(0), "", recordText(2)]);
  const [e0, , e2] = f.eventIds as [string, string, string];
  const model = segmentModelProducer(f.vault);
  const receipt = await sync(f, model.producer);
  expect(model.requests.map((request) => request.event_ids)).toEqual([[e0], [e2]]);
  expect(receipt).toMatchObject({ status: "ok", errors: [], claims_extracted: 2 });
  expect(receipt.oversized).toBeUndefined();
  expect(endsAt(readExtractCursor(f.db), e2)).toBe(true);
  expect(oversizedRows(f.db)).toEqual([]);
});

test("purge drops a record's segment progress; backup and restore keep progress and receipts", async () => {
  const f = vaultWith([SIXTY_K, "k".repeat(30_000), recordText(2)], SETTINGS.replace("max_calls_per_pass = 12", "max_calls_per_pass = 2"));
  const [e0, e1] = f.eventIds as [string, string];
  const model = segmentModelProducer(f.vault);
  await sync(f, model.producer);
  const progress = oversizedRows(f.db);
  expect(progress).toMatchObject([{ event_id: e0, status: "segmenting" }]);
  const backup = `${f.vault}-backup`, target = `${f.vault}-restored`;
  disposers.push(() => spawnSync("rm", ["-rf", backup, target]));
  exportVault(f.db, f.vault, backup);
  restoreVault(backup, target);
  const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
  try { expect(oversizedRows(restored)).toEqual(progress); } finally { restored.close(); }

  purgeEvents(f.db, f.vault, { event_id: e0 }, "synthetic cleanup");
  expect(oversizedRows(f.db)).toEqual([]);
  await sync(f, model.producer);
  expect(listSkippedRecords(f.db).map((row) => row.event_id)).toEqual([e1]);
});
