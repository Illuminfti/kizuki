import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import {
  MIN_RECORD_CONTENT_CHARS,
  prefilterReason,
} from "../../src/serve/extract-prefilter";
import { journalExtractBatch, mineLiveDrafts, readExtractCursor, requeuePassedOverRecords } from "../../src/serve/extract";
import { runRail } from "../../src/serve/rails";
import { listRunReceipts } from "../../src/serve/receipts";
import {
  MODEL,
  fixtureProducer,
  recordText,
  throughputVault,
  writeServeToml,
} from "./throughput-fixture";

// A thousand committed steps on a loaded host outlast the default deadline.
setDefaultTimeout(120_000);

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

const SHORT = [
  "ok",
  "k",
  "\u{1F44D}",
  "\u{1F602}\u{1F602}\u{1F602}",
  "thanks!",
  "lol",
  "...",
  "   ",
  "",
  "sounds good",
  "+1",
  "12:30",
];

test("a record with nothing to extract is named by reason and everything else goes on", () => {
  const cases: [string, ReturnType<typeof prefilterReason>][] = [
    ["", "empty"],
    [" \n\t ", "empty"],
    ["\u{1F44D}\u{1F44D}\u{1F44D}", "no_words"],
    ["?!... --- ***", "no_words"],
    ["ok", "too_short"],
    ["thanks!", "too_short"],
    ["see you at 5", "too_short"],
    ["我住在东京", null],
    ["I moved to Rome", null],
    ["Ada joined the orchard library project.", null],
    [`${"\u{1F44D}".repeat(50)} ok`, "too_short"],
  ];
  for (const [text, reason] of cases)
    expect([text, prefilterReason({ text })]).toEqual([text, reason]);
  expect(
    prefilterReason({ text: "a".repeat(MIN_RECORD_CONTENT_CHARS - 1) }),
  ).toBe("too_short");
  expect(
    prefilterReason({ text: "a".repeat(MIN_RECORD_CONTENT_CHARS) }),
  ).toBeNull();
  // A very long record of emoji is decided without copying or counting all of it.
  expect(prefilterReason({ text: "\u{1F44D}".repeat(500_000) })).toBe(
    "no_words",
  );
});

test("a thousand short messages cost no model call, and the receipt counts each by reason", async () => {
  const vault = throughputVault(1_000, (index) => SHORT[index % SHORT.length]!);
  const db = openLedger(vault.ledger);
  disposers.push(vault.dispose, () => db.close());
  const { producer, calls } = fixtureProducer(() => db);

  const receipt = await runRail(db, vault.vault, "sync", {
    hooks: { producer, claims: { db }, model_ref: MODEL },
  });

  expect(calls).toEqual([]);
  expect(receipt.model.calls).toBe(0);
  expect(receipt.stopped).toBeNull();
  expect(receipt.errors).toEqual([]);
  // "sounds good" and "12:30" have too few letters and digits; "", "   " have no text at all.
  const per = (text: string) =>
    vault.eventIds.filter((_, index) => SHORT[index % SHORT.length] === text)
      .length;
  expect(receipt.records_prefiltered).toEqual({
    empty: per("") + per("   "),
    no_words:
      per("\u{1F44D}") + per("\u{1F602}\u{1F602}\u{1F602}") + per("..."),
    too_short:
      per("ok") +
      per("k") +
      per("thanks!") +
      per("lol") +
      per("sounds good") +
      per("+1") +
      per("12:30"),
  });
  expect(
    Object.values(receipt.records_prefiltered ?? {}).reduce(
      (sum, count) => sum + count,
      0,
    ),
  ).toBe(1_000);
  // The cursor is past the last record, so the next pass finds nothing to do.
  expect(readExtractCursor(db)?.endsWith(`\t${vault.eventIds.at(-1)!}`)).toBe(
    true,
  );
  const next = await runRail(db, vault.vault, "sync", {
    hooks: { producer, claims: { db }, model_ref: MODEL },
  });
  expect(next.records_prefiltered).toBeUndefined();
  expect(calls).toEqual([]);
  // The receipt is readable from the journal with its counts.
  expect(
    listRunReceipts(db, { limit: 5 }).find(
      (item) => item.run_id === receipt.run_id,
    )?.records_prefiltered,
  ).toEqual(receipt.records_prefiltered);
});

test("a host stop callback runs between prefilter-only extraction steps", async () => {
  const vault = throughputVault(1_000, () => "ok");
  const db = openLedger(vault.ledger);
  disposers.push(vault.dispose, () => db.close());
  const { producer, calls } = fixtureProducer(() => db);
  let stop = false;
  const task = setImmediate(() => { stop = true; });
  try {
    const receipt = await runRail(db, vault.vault, "sync", {
      hooks: { producer, claims: { db }, model_ref: MODEL },
      stopRequested: () => stop,
    });
    expect(receipt.stopped).toBe("serve:stop_requested");
    expect(receipt.records_prefiltered?.["too_short"] ?? 0).toBeLessThanOrEqual(8);
    expect(calls).toEqual([]);
  } finally { clearImmediate(task); }
});

test("previously deferred short records are consumed without a model call", async () => {
  const vault = throughputVault(16, index => index % 2 === 0 ? "ok" : recordText(index));
  const db = openLedger(vault.ledger);
  disposers.push(vault.dispose, () => db.close());
  db.transaction(() => requeuePassedOverRecords(db, vault.eventIds))();
  const { producer, calls } = fixtureProducer(() => db);
  const receipt = await runRail(db, vault.vault, "sync", {
    hooks: { producer, claims: { db }, model_ref: MODEL },
  });
  expect(calls.flatMap(call => call.event_ids).some(id => vault.eventIds.indexOf(id) % 2 === 0)).toBe(false);
  expect(receipt.records_prefiltered).toEqual({ too_short: 1 });
  expect(db.query("SELECT 1 FROM extract_deferred_inputs WHERE event_id=?").get(vault.eventIds[0]!)).toBeNull();
});

test("explicit service records are skipped even when their notice contains words", () => {
  expect(prefilterReason({ kind: "service", text: "A participant joined this conversation." })).toBe("service");
  expect(prefilterReason({ kind: "service_message", text: "The conversation title was changed." })).toBe("service");
  expect(prefilterReason({ kind: "message", text: "A participant joined this conversation." })).toBeNull();
});

test("short records around a segmented record are counted once when the cursor passes them", async () => {
  const texts = ["ok", "Segment material describes a synthetic import. ".repeat(1_300), "thanks!"];
  const vault = throughputVault(3, index => texts[index]!);
  const db = openLedger(vault.ledger);
  disposers.push(vault.dispose, () => db.close());
  const { producer } = fixtureProducer(() => db);
  let count = 0;
  for (let pass = 0; pass < 8; pass++) {
    const receipt = await runRail(db, vault.vault, "sync", {
      hooks: { producer, claims: { db }, model_ref: MODEL },
    });
    expect(receipt.errors).toEqual([]);
    if (pass === 0) expect(receipt.records_prefiltered).toBeUndefined();
    count += receipt.records_prefiltered?.["too_short"] ?? 0;
  }
  expect(count).toBe(2);
  expect(readExtractCursor(db)?.endsWith(`\t${vault.eventIds.at(-1)!}`)).toBe(true);
});

test("a journaled decision counts its trivial records on replay after restart", async () => {
  const vault = throughputVault(5, index => index === 0 || index === 2 ? "ok" : recordText(index));
  let db = openLedger(vault.ledger);
  disposers.push(vault.dispose, () => db.close());
  const { producer, calls } = fixtureProducer(() => db);
  const mined = await mineLiveDrafts(db, producer);
  journalExtractBatch(db, mined, MODEL, producer);
  db.close();
  db = openLedger(vault.ledger);
  const receipt = await runRail(db, vault.vault, "sync", {
    hooks: { producer, claims: { db }, model_ref: MODEL },
  });
  expect(receipt.errors).toEqual([]);
  expect(receipt.records_prefiltered).toEqual({ too_short: 2 });
  expect(calls).toHaveLength(1);
  // Filing a meaningful journal still spends the one extraction step: the
  // remaining record waits for the next pass even though this replay counted skips.
  expect(readExtractCursor(db)?.endsWith(`\t${vault.eventIds[3]!}`)).toBe(true);
  await runRail(db, vault.vault, "sync", {
    hooks: { producer, claims: { db }, model_ref: MODEL },
  });
  expect(calls).toHaveLength(2);
  expect(readExtractCursor(db)?.endsWith(`\t${vault.eventIds.at(-1)!}`)).toBe(true);
});

test("short messages between real ones never reach the model and never hold the cursor back", async () => {
  const texts = (index: number) =>
    index % 3 === 0 ? recordText(index) : SHORT[index % SHORT.length]!;
  const vault = throughputVault(30, texts);
  const db = openLedger(vault.ledger);
  disposers.push(vault.dispose, () => db.close());
  writeServeToml(vault.vault, "[extraction]\nmax_calls_per_pass = 8\n");
  const { producer, calls } = fixtureProducer(() => db);

  let prefiltered = 0;
  for (let pass = 0; pass < 6; pass++) {
    const receipt = await runRail(db, vault.vault, "sync", {
      hooks: { producer, claims: { db }, model_ref: MODEL },
    });
    prefiltered += Object.values(receipt.records_prefiltered ?? {}).reduce(
      (sum, count) => sum + count,
      0,
    );
  }

  const real = vault.eventIds.filter((_, index) => index % 3 === 0);
  expect(calls.flatMap((call) => call.event_ids)).toEqual(real);
  expect(prefiltered).toBe(vault.eventIds.length - real.length);
  expect(readExtractCursor(db)?.endsWith(`\t${vault.eventIds.at(-1)!}`)).toBe(
    true,
  );
});

test("passing over short messages uses no extraction step, but the pass time budget still ends it", async () => {
  const vault = throughputVault(400, (index) => SHORT[index % SHORT.length]!);
  const db = openLedger(vault.ledger);
  disposers.push(vault.dispose, () => db.close());
  writeServeToml(vault.vault, "[extraction]\nmax_pass_seconds = 30\n");
  const { producer } = fixtureProducer(() => db);
  // Every reading of the clock is a second later, so the budget is spent after a few steps.
  let ticks = 0;
  const now = () =>
    new Date(Date.UTC(2026, 8, 29) + ticks++ * 1_000).toISOString();

  const first = await runRail(db, vault.vault, "sync", {
    hooks: { producer, claims: { db }, model_ref: MODEL },
    now,
  });
  const passed = Object.values(first.records_prefiltered ?? {}).reduce(
    (sum, count) => sum + count,
    0,
  );
  expect(passed).toBeGreaterThan(8);
  expect(passed).toBeLessThan(400);
  expect(readExtractCursor(db)?.endsWith(`\t${vault.eventIds.at(-1)!}`)).toBe(
    false,
  );

  let total = passed;
  for (let pass = 0; pass < 40 && total < 400; pass++) {
    const receipt = await runRail(db, vault.vault, "sync", {
      hooks: { producer, claims: { db }, model_ref: MODEL },
      now,
    });
    total += Object.values(receipt.records_prefiltered ?? {}).reduce(
      (sum, count) => sum + count,
      0,
    );
  }
  expect(total).toBe(400);
});
