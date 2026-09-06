import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite } from "../../src/canon/apply";
import { resolveTarget } from "../../src/canon/arbiter";
import { BudgetExhausted, createBudgetTracker } from "../../src/canon/budget";
import { CanonWriteError } from "../../src/canon/errors";
import { RECEIPTS_PATH, listCanonReceipts, readReceiptsLog } from "../../src/canon/receipts";
import { getClaim } from "../../src/claims/store";
import type { Claim } from "../../src/contracts/proposal";
import { proposalsForEvent } from "../../src/staging/producers";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { MAX_FRONTMATTER_ARRAY_ITEMS } from "../../src/vault/schema";
import { subjectPageType } from "../../src/vault/subject-type";
import { eventFacts } from "../claims/helpers";
import { event } from "../staging/helpers";
import { canonFixture, putEvent, storeClaim, write } from "./helpers";
import type { CanonFixture } from "./helpers";

const fixtures: CanonFixture[] = [];

function fixture(): CanonFixture {
  const created = canonFixture();
  fixtures.push(created);
  return created;
}

afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose();
});

function code(error: unknown): string {
  return error instanceof CanonWriteError ? error.code : String(error);
}

function attempt(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Fails the receipt row insert only, after the file and the JSONL line. */
function failingOnReceiptRow(db: Database): Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "query") {
        return (sql: string) => {
          if (sql.includes("INSERT INTO canon_receipts")) {
            throw new Error("synthetic storage failure");
          }
          return target.query(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe("applyCanonWrite", () => {
  test("budget is charged before any effect and stops the pass cleanly", async () => {
    const { db, io, vault } = fixture();
    const eventId = putEvent(db);
    const first = await storeClaim(db, eventId);
    const second = await storeClaim(db, eventId, {
      target: "people/linus",
      subject: "person:linus",
      subjects: ["person:linus"],
      body: "Linus keeps the kernel notes.",
      frontmatter: { type: "person", title: "Linus" },
    });
    const budget = createBudgetTracker({ canon_writes_per_run: 1 });

    applyCanonWrite(io, first, resolveTarget(io, first), { writer: "loop", budget });
    expect(budget.usage().canon_writes_per_run).toEqual({ used: 1, limit: 1 });

    const stopped = attempt(() =>
      applyCanonWrite(io, second, resolveTarget(io, second), { writer: "loop", budget }),
    );
    expect(stopped).toBeInstanceOf(BudgetExhausted);
    expect((stopped as BudgetExhausted).stopped).toBe("budget:canon_writes_per_run");
    expect(existsSync(join(vault, "people", "linus.md"))).toBe(false);
    expect(readReceiptsLog(vault)).toHaveLength(1);
    expect(getClaim(db, second.claim_id)?.receipt_id).toBeNull();

    const daily = createBudgetTracker({
      canon_writes_per_run: 10,
      canon_writes_per_day: { limit: 5, used: 5 },
    });
    const dayStopped = attempt(() =>
      applyCanonWrite(io, second, resolveTarget(io, second), { writer: "loop", budget: daily }),
    );
    expect((dayStopped as BudgetExhausted).stopped).toBe("budget:canon_writes_per_day");

    // Unknown claims fail trust preflight before admission spends a write unit.
    const strict = createBudgetTracker({ canon_writes_per_run: 1 });
    const ghost: Claim = { ...second, claim_id: "01GHOST00000000000000000000" };
    expect(
      code(attempt(() =>
        applyCanonWrite(io, ghost, { action: "create", rel_path: "people/ghost.md" }, {
          writer: "loop",
          budget: strict,
        }),
      )),
    ).toBe("claim_unknown");
    expect(
      attempt(() =>
        applyCanonWrite(io, second, resolveTarget(io, second), { writer: "loop", budget: strict }),
      ),
    ).toBeUndefined();
    expect(strict.usage().canon_writes_per_run.used).toBe(1);

    // A skip decision is not a write and does not charge.
    const untouched = createBudgetTracker({ canon_writes_per_run: 1 });
    expect(
      code(attempt(() =>
        applyCanonWrite(io, second, { action: "skip", reason: "duplicate" }, {
          writer: "loop",
          budget: untouched,
        }),
      )),
    ).toBe("nothing_to_write");
    expect(untouched.usage().canon_writes_per_run.used).toBe(0);
  });

  test("the order of effects is file, JSONL receipt, then database row", async () => {
    const { db, io, vault } = fixture();
    const eventId = putEvent(db);
    const claim = await storeClaim(db, eventId);
    const decision = resolveTarget(io, claim);
    const failing = { ...io, db: failingOnReceiptRow(db) };

    expect(() =>
      applyCanonWrite(failing, claim, decision, { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 1 }) }),
    ).toThrow(/synthetic storage failure/);

    // The page and its receipt line exist; the row does not: a crash here is
    // visible to doctor as an orphan receipt, never a silent loss.
    expect(existsSync(join(vault, "people", "grace.md"))).toBe(true);
    const lines = readFileSync(join(vault, RECEIPTS_PATH), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(listCanonReceipts(db)).toEqual([]);
    expect(getClaim(db, claim.claim_id)?.receipt_id).toBeNull();
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM page_index").get()?.n,
    ).toBe(0);
  });

  test("refuses bad writers, stale decisions, unknown or altered claims and reserved keys", async () => {
    const { db, io, vault } = fixture();
    const eventId = putEvent(db);
    const claim = await storeClaim(db, eventId);
    const decision = resolveTarget(io, claim);
    const opts = { budget: createBudgetTracker({ canon_writes_per_run: 100 }) };

    expect(code(attempt(() => applyCanonWrite(io, claim, decision, { ...opts, writer: "owner" as never })))).toBe(
      "writer_invalid",
    );
    expect(code(attempt(() => applyCanonWrite(io, [], decision, { ...opts, writer: "loop" })))).toBe(
      "nothing_to_write",
    );
    const altered: Claim = { ...claim, body: "Something the store never saw.", body_hash: "0".repeat(64) };
    expect(code(attempt(() => applyCanonWrite(io, altered, decision, { ...opts, writer: "loop" })))).toBe(
      "claim_mismatch",
    );
    const reserved: Claim = { ...claim, frontmatter: { ...claim.frontmatter, sensitivity: "public" } };
    expect(code(attempt(() => applyCanonWrite(io, reserved, decision, { ...opts, writer: "loop" })))).toBe(
      "frontmatter_reserved",
    );
    expect(
      code(attempt(() =>
        applyCanonWrite(io, claim, { action: "edit", page_id: "nope", rel_path: "people/grace.md", reason: "explicit" }, {
          ...opts,
          writer: "loop",
        }),
      )),
    ).toBe("page_missing");
    expect(existsSync(join(vault, "people", "grace.md"))).toBe(false);
    expect(readReceiptsLog(vault)).toEqual([]);

    const receipt = applyCanonWrite(io, claim, decision, { ...opts, writer: "loop" });
    expect(code(attempt(() => applyCanonWrite(io, claim, decision, { ...opts, writer: "loop" })))).toBe(
      "decision_stale",
    );
    const fresh = await storeClaim(db, eventId, {
      predicate: "location.based_in",
      object: "lisbon",
      body: "Grace is based in Lisbon.",
    });
    expect(
      code(attempt(() =>
        applyCanonWrite(io, fresh, { action: "create", rel_path: "people/grace.md" }, { ...opts, writer: "loop" }),
      )),
    ).toBe("page_exists");
    expect(readReceiptsLog(vault)).toEqual([receipt]);
    expect(readdirSync(join(vault, "archive"))).toEqual([]);
  });

  test("a caller-built decision cannot name a path outside the vault or the archive", async () => {
    const { db, io, vault } = fixture();
    const claim = await storeClaim(db, putEvent(db));
    const opts = { writer: "loop" as const, budget: createBudgetTracker({ canon_writes_per_run: 100 }) };
    for (const rel_path of [
      "../escape.md",
      "/tmp/escape.md",
      "people/../../escape.md",
      "archive/grace.md",
      ".kizuki/grace.md",
      "CANON.md",
      "people/grace.txt",
      "people/grace",
      `people/${"g".repeat(70)}.md`,
    ]) {
      expect(code(attempt(() => applyCanonWrite(io, claim, { action: "create", rel_path }, opts)))).toBe(
        "target_invalid",
      );
    }
    expect(existsSync(join(vault, "..", "escape.md"))).toBe(false);
    expect(readReceiptsLog(vault)).toEqual([]);
    expect(opts.budget.usage().canon_writes_per_run.used).toBe(0);
  });

  test("a batch shares producer, kind and subject; frontmatter must agree", async () => {
    const { db, io } = fixture();
    const eventId = putEvent(db);
    const grace = await storeClaim(db, eventId);
    const linus = await storeClaim(db, eventId, {
      target: "people/linus",
      subject: "person:linus",
      subjects: ["person:linus"],
      body: "Linus keeps the kernel notes.",
      frontmatter: { type: "person", title: "Linus" },
    });
    const decision = resolveTarget(io, grace);
    expect(code(attempt(() => write(io, [grace, linus], { decision })))).toBe("batch_mismatch");

    const model = await storeClaim(db, eventId, {
      predicate: "contact.email",
      object: "grace@acme.test",
      body: "Contact: grace@acme.test.",
      producer: "model",
      model_ref: "kizuki.llm.openai-compatible:synthetic@127.0.0.1",
    });
    expect(code(attempt(() => write(io, [grace, model], { decision })))).toBe("batch_mismatch");

    const retitled = await storeClaim(db, eventId, {
      predicate: "location.based_in",
      object: "lisbon",
      body: "Grace is based in Lisbon.",
      frontmatter: { type: "person", title: "Grace Hopper" },
    });
    expect(code(attempt(() => write(io, [grace, retitled], { decision })))).toBe(
      "frontmatter_conflict",
    );
  });

  test("edit replaces prose, merge appends, and sensitivity never loosens", async () => {
    const { db, io, vault } = fixture();
    const eventId = putEvent(db);
    const created = write(io, await storeClaim(db, eventId, { sensitivity: "private" }));
    const path = join(vault, created.page_path);
    expect(parseFrontmatter(readFileSync(path, "utf8")).data["sensitivity"]).toBe("private");

    const merged = write(
      io,
      await storeClaim(db, eventId, {
        kind: "merge",
        predicate: null,
        object: null,
        body: "Also mentors the partnerships team.",
        frontmatter: {},
        sensitivity: "public",
      }),
    );
    expect(merged.page_action).toBe("edit");
    let page = parseFrontmatter(readFileSync(path, "utf8"));
    expect(page.body).toBe("Grace runs partnerships at Acme.\n\nAlso mentors the partnerships team.\n");
    expect(page.data["sensitivity"]).toBe("private");
    expect(page.data["sources"]).toEqual([eventId]);

    const edited = write(
      io,
      await storeClaim(db, eventId, {
        kind: "edit",
        predicate: null,
        object: null,
        body: "Grace leads partnerships at Acme.",
        frontmatter: { title: "Grace (Acme)" },
        sensitivity: "personal",
      }),
    );
    expect(edited.before_hash).toBe(merged.after_hash);
    page = parseFrontmatter(readFileSync(path, "utf8"));
    expect(page.body).toBe("Grace leads partnerships at Acme.\n");
    expect(page.data["title"]).toBe("Grace (Acme)");
    expect(page.data["sensitivity"]).toBe("private");
    expect(page.data["taint"]).toBe("clean");
    expect(readdirSync(join(vault, "archive"))).toHaveLength(2);
  });

  test("a second claim on a page recomposes the body from its live claims", async () => {
    const { db, io, vault } = fixture();
    const eventId = putEvent(db);
    const created = write(io, await storeClaim(db, eventId));
    const second = write(
      io,
      await storeClaim(db, eventId, {
        predicate: "location.based_in",
        object: "lisbon",
        body: "Grace is based in Lisbon.",
        taint: "quoted",
      }),
    );
    const page = parseFrontmatter(readFileSync(join(vault, created.page_path), "utf8"));
    expect(page.body).toBe("Grace runs partnerships at Acme. Grace is based in Lisbon.\n");
    expect(page.data["taint"]).toBe("quoted");
    expect(second.taint).toBe("quoted");
    expect(second.claim_ids).toHaveLength(1);
    expect(page.data["id"]).toBe(
      parseFrontmatter(readFileSync(join(vault, created.page_path), "utf8")).data["id"],
    );
  });

  test("a single-subject capture note keeps the entity page type the subject chose", async () => {
    const { db, io, vault } = fixture();
    const subject = "calendar:standup";
    const expectedType = subjectPageType(subject);
    expect(expectedType).toBe("topic");

    const captured = event({
      connector_id: "kizuki.google-calendar",
      kind: "calendar_event",
      subjects: [{ subject_id: subject, role: "about", display_name: "standup" }],
    });
    const proposals = proposalsForEvent(captured);
    const entityInput = proposals.find((item) => item.kind === "entity");
    const noteInput = proposals.find((item) => item.kind === "claim");
    if (entityInput === undefined || noteInput === undefined) {
      throw new Error("deterministic floor must emit an entity and a capture note");
    }
    expect(entityInput.frontmatter["type"]).toBe(expectedType);
    expect(noteInput.frontmatter["type"]).toBe("source");
    expect(noteInput.target).toBeNull();

    const eventId = putEvent(db);
    const created = write(
      io,
      await storeClaim(db, eventId, {
        kind: "entity",
        target: entityInput.target ?? subject,
        subject,
        subjects: entityInput.subjects ?? [subject],
        predicate: null,
        object: null,
        body: entityInput.body,
        frontmatter: entityInput.frontmatter,
      }),
    );
    expect(parseFrontmatter(readFileSync(join(vault, created.page_path), "utf8")).data["type"]).toBe(
      expectedType,
    );

    const note = await storeClaim(db, eventId, {
      kind: "claim",
      target: null,
      subject,
      subjects: noteInput.subjects ?? [subject],
      predicate: null,
      object: null,
      body: noteInput.body,
      frontmatter: noteInput.frontmatter,
    });
    expect(resolveTarget(io, note)).toEqual({
      action: "edit",
      page_id: expect.any(String),
      rel_path: created.page_path,
      reason: "subject",
    });
    write(io, note);
    expect(parseFrontmatter(readFileSync(join(vault, created.page_path), "utf8")).data["type"]).toBe(
      expectedType,
    );
  });

  test("refuses a revision that would grow sources past the frontmatter cap before admission", async () => {
    const { db, io, vault } = fixture();
    const events = Array.from({ length: MAX_FRONTMATTER_ARRAY_ITEMS }, () => putEvent(db));
    const created = write(
      io,
      await storeClaim(db, events[0]!, {
        provenance: events,
        events: events.map((eventId) => eventFacts(eventId)),
      }),
    );
    const path = join(vault, created.page_path);
    const before = readFileSync(path);
    expect(parseFrontmatter(before.toString("utf8")).data["sources"]).toHaveLength(
      MAX_FRONTMATTER_ARRAY_ITEMS,
    );

    const extra = putEvent(db);
    const overflow = await storeClaim(db, extra, {
      kind: "edit",
      predicate: null,
      object: null,
      body: "Grace still runs partnerships at Acme.",
      frontmatter: {},
      provenance: [extra],
      events: [eventFacts(extra)],
    });
    const refused = attempt(() => write(io, overflow));
    expect(code(refused)).toBe("frontmatter_invalid");
    expect(String(refused)).toContain(`sources: exceeds ${MAX_FRONTMATTER_ARRAY_ITEMS} items`);
    expect(readFileSync(path)).toEqual(before);
    expect(db.query("SELECT 1 FROM canon_machine_byte_intents").get()).toBeNull();
    expect(getClaim(db, overflow.claim_id)?.receipt_id).toBeNull();

    const sameSources = await storeClaim(db, events[0]!, {
      kind: "edit",
      predicate: null,
      object: null,
      body: "Grace continues to run partnerships at Acme.",
      frontmatter: {},
      provenance: [events[0]!],
      events: [eventFacts(events[0]!)],
    });
    write(io, sameSources);
    expect(parseFrontmatter(readFileSync(path, "utf8")).data["sources"]).toHaveLength(
      MAX_FRONTMATTER_ARRAY_ITEMS,
    );
  });
});
