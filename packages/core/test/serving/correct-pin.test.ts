import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite, createBudgetTracker, resolveTarget } from "../../src/canon";
import { SENSITIVITY_ORDER } from "../../src/agents/types";
import { getClaim, insertClaim, listClaims, listSupersessions } from "../../src/claims/store";
import { correct } from "../../src/correction/correct";
import { serveCorrect } from "../../src/serving/correct";
import { serveSearch } from "../../src/serving/search";
import { ServeError } from "../../src/serving/types";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";
import { worldFixture } from "./world-fixture";
import { readWorldView } from "../../src/serving/world-view";
import { worldCanonTarget } from "../../src/canon/world-materialization";

let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

const CANARY = "PRIVATE-CANARY-KETTLE-7741";

async function refusal(run: () => Promise<unknown>): Promise<ServeError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected a ServeError");
}

/** A public claim the receipted writer has already put on a page. */
async function writtenPublicClaim(live: Fixture, unkeyed = false): Promise<{ claimId: string; claimKey: string; pagePath: string }> {
  const filed = await insertClaim(
    { db: live.db },
    {
      kind: "claim",
      target: "facts:workplace",
      body: "Linus works at acme.",
      frontmatter: { type: "fact", title: "Where Linus works" },
      subjects: ["person:linus"],
      ...(unkeyed ? {} : { subject: "person:linus", predicate: "employment.works_at", object: "acme" }),
      provenance: [live.events["public"] as string],
      producer: "deterministic",
      confidence: 1,
    },
  );
  if (filed.outcome !== "stored") throw new Error(filed.outcome);
  expect(filed.claim.sensitivity).toBe("public");
  const io = { db: live.db, vault_path: live.vaultPath };
  const receipt = applyCanonWrite(io, filed.claim, resolveTarget(io, filed.claim), {
    writer: "loop",
    budget: createBudgetTracker({ canon_writes_per_run: 4 }),
  });
  return { claimId: filed.claim.claim_id, claimKey: filed.claim.claim_key ?? "", pagePath: receipt.page_path };
}

function eventHint(live: Fixture, eventId: string): "public" | "personal" | "private" {
  return live.db
    .query<{ sensitivity_hint: "public" | "personal" | "private" }, [string]>(
      "SELECT sensitivity_hint FROM events WHERE event_id=?",
    )
    .get(eventId)!.sensitivity_hint;
}

describe("a relayed correction cannot override the owner's own correction (R22-13)", () => {
  test("a relay-enabled agent is held and the owner's claim stays live", async () => {
    fixture = await serveFixture();
    const live = fixture;
    const { claimId, claimKey } = await writtenPublicClaim(live);
    const owner = await serveCorrect(live.owner(), {
      statement: "Linus works at the workshop.",
      target: { claim_id: claimId },
      object: "the workshop",
    });
    const ownerClaim = owner.data!.claim_id!;
    expect(getClaim(live.db, ownerClaim)?.producer).toBe("owner");
    const eventsBefore = live.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events").get()!.n;

    for (const target of [{ claim_key: claimKey }, { claim_id: ownerClaim }]) {
      const held = await refusal(() =>
        serveCorrect(live.agent("reader-private"), {
          statement: "Linus works at Contoso.",
          target,
          object: "Contoso",
        }),
      );
      expect(held.code).toBe("held");
      expect(held.message).toContain("owner's own correction");
    }
    expect(getClaim(live.db, ownerClaim)?.status).toBe("live");
    expect(listClaims(live.db, { claim_key: claimKey, status: "live" }).map((claim) => claim.claim_id)).toEqual([ownerClaim]);
    // Held before any evidence was recorded.
    expect(live.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events").get()!.n).toBe(eventsBefore);

    // The owner speaking directly still can.
    const replaced = await serveCorrect(live.owner(), {
      statement: "Linus works at Contoso.",
      target: { claim_key: claimKey },
      object: "Contoso",
    });
    expect(getClaim(live.db, ownerClaim)?.status).toBe("superseded");
    expect(getClaim(live.db, replaced.data!.claim_id!)?.status).toBe("live");
  });

  test("the pin holds for the owner's correction of a claim with no predicate", async () => {
    fixture = await serveFixture();
    const live = fixture;
    const filed = await insertClaim(
      { db: live.db },
      {
        kind: "claim",
        target: "facts:keyless",
        body: "A reading with nothing to key it.",
        subjects: ["person:ada"],
        provenance: [live.events["public"] as string],
        producer: "deterministic",
        confidence: 1,
      },
    );
    if (filed.outcome !== "stored") throw new Error(filed.outcome);
    const owner = await serveCorrect(live.owner(), {
      statement: "That reading was wrong.",
      target: { claim_id: filed.claim.claim_id },
    });
    const ownerClaim = owner.data!.claim_id!;
    for (const name of ["reader-private", "downgraded"]) {
      const held = await refusal(() =>
        serveCorrect(live.agent(name), { statement: "Actually it was right.", target: { claim_id: ownerClaim } }),
      );
      expect(held.code).toBe("held");
      expect(held.message).toContain("owner's own correction");
    }
    expect(getClaim(live.db, ownerClaim)?.status).toBe("live");
  });

  test.each([false, true])("a downgraded relay cannot retire another relay's owner correction (unkeyed=%s)", async (unkeyed) => {
    fixture = await serveFixture();
    const live = fixture;
    const { claimId, claimKey, pagePath } = await writtenPublicClaim(live, unkeyed);
    const relayed = await serveCorrect(live.agent("reader-private"), {
      statement: "Linus works at the workshop.", target: { claim_id: claimId },
      ...(unkeyed ? {} : { object: "the workshop" }),
    });
    const winnerId = relayed.data!.claim_id!;
    expect(getClaim(live.db, winnerId)?.authority).toBe("owner_correction");
    expect(getClaim(live.db, winnerId)?.producer).toBe("agent:reader-private");
    const before = readFileSync(join(live.vaultPath, pagePath), "utf8");
    const eventsBefore = live.db.query("SELECT count(*) AS n FROM events").get();
    const receiptsBefore = live.db.query("SELECT count(*) AS n FROM canon_receipts").get();
    const supersessionsBefore = listSupersessions(live.db);
    const held = await refusal(() => serveCorrect(live.agent("downgraded"), {
      statement: "Linus works at Contoso.",
      target: unkeyed ? { claim_id: winnerId } : { claim_key: claimKey },
      ...(unkeyed ? {} : { object: "Contoso" }),
    }));
    expect(held.code).toBe("held");
    expect(held.message).toBe("correction is below the live claim's authority");
    expect(getClaim(live.db, winnerId)?.status).toBe("live");
    expect(readFileSync(join(live.vaultPath, pagePath), "utf8")).toBe(before);
    expect(live.db.query("SELECT count(*) AS n FROM events").get()).toEqual(eventsBefore);
    expect(live.db.query("SELECT count(*) AS n FROM canon_receipts").get()).toEqual(receiptsBefore);
    expect(listSupersessions(live.db)).toEqual(supersessionsBefore);
  });
});

describe("a relayed correction cannot launder or declassify text (R26-3)", () => {
  test("private text relayed onto a public claim files private, quoted and attributed", async () => {
    fixture = await serveFixture();
    const live = fixture;
    const { claimId, pagePath } = await writtenPublicClaim(live);

    const relayed = await serveCorrect(live.agent("reader-private"), {
      statement: `Linus works at ${CANARY}.`,
      target: { claim_id: claimId },
      object: CANARY,
    });
    const correction = getClaim(live.db, relayed.data!.claim_id!)!;
    expect(correction.authority).toBe("owner_correction");
    expect(correction.taint).toBe("quoted");
    expect(correction.frontmatter["x-relayed-by"]).toBe("agent:reader-private");
    expect(correction.sensitivity).toBe("private");

    // The page cannot be lower than what it now holds, and lists no evidence above its own tier.
    const page = parseFrontmatter(readFileSync(join(live.vaultPath, pagePath), "utf8"));
    expect(page.data["sensitivity"]).toBe("private");
    expect(page.data["taint"]).toBe("quoted");
    const tier = SENSITIVITY_ORDER[page.data["sensitivity"] as "private"];
    const sources = page.data["sources"] as string[];
    expect(sources).toContain(relayed.data!.event_id!);
    for (const source of sources) expect(SENSITIVITY_ORDER[eventHint(live, source)]).toBeLessThanOrEqual(tier);

    // A public-ceiling reader finds neither the canary nor the statement's event id.
    for (const query of [CANARY, "Linus", "acme"]) {
      const found = await serveSearch(live.agent("reader-public"), { query });
      expect(found.canon.map((chunk) => chunk.excerpt).join("\n")).not.toContain(CANARY);
      for (const chunk of found.canon) {
        expect(chunk.sources).not.toContain(relayed.data!.event_id!);
        expect(chunk.path).not.toBe(pagePath);
      }
    }
    // The private reader still sees it, so the owner's agent is not blinded.
    const priv = await serveSearch(live.agent("reader-private"), { query: CANARY });
    expect(priv.canon.map((chunk) => chunk.path)).toContain(pagePath);
  });

  test.each([false, true])("the owner's MCP correction respects statement sensitivity (unkeyed=%s)", async (unkeyed) => {
    fixture = await serveFixture();
    const live = fixture;
    const { claimId, pagePath } = await writtenPublicClaim(live, unkeyed);
    const direct = await serveCorrect(live.owner(), {
      statement: "Linus works at the workshop.",
      target: { claim_id: claimId },
      ...(unkeyed ? {} : { object: "the workshop" }),
    });
    const correction = getClaim(live.db, direct.data!.claim_id!)!;
    expect(correction.sensitivity).toBe("private");
    expect(eventHint(live, direct.data!.event_id!)).toBe("private");
    expect(correction.taint).toBe("clean");
    expect(correction.frontmatter["x-relayed-by"]).toBeUndefined();
    const page = parseFrontmatter(readFileSync(join(live.vaultPath, pagePath), "utf8"));
    expect(page.data["sensitivity"]).toBe("private");
    const tier = SENSITIVITY_ORDER[page.data["sensitivity"] as "private"];
    expect(page.data["sources"]).toContain(direct.data!.event_id!);
    for (const source of page.data["sources"] as string[]) {
      expect(SENSITIVITY_ORDER[eventHint(live, source)]).toBeLessThanOrEqual(tier);
    }
    const found = await serveSearch(live.agent("reader-public"), { query: "workshop" });
    expect(found.canon.map((chunk) => chunk.path)).not.toContain(pagePath);
    expect(JSON.stringify(found)).not.toContain(direct.data!.event_id!);
  });

  test.each([false, true])("the tell core seam respects statement sensitivity (unkeyed=%s)", async (unkeyed) => {
    fixture = await serveFixture();
    const live = fixture;
    const { claimId, pagePath } = await writtenPublicClaim(live, unkeyed);
    const direct = await correct({ db: live.db, vault_path: live.vaultPath }, {
      statement: "Linus works at the workshop.", target: { claim_id: claimId },
    });
    expect(getClaim(live.db, direct.claim_ids[0]!)?.sensitivity).toBe("private");
    expect(eventHint(live, direct.event_id)).toBe("private");
    const page = parseFrontmatter(readFileSync(join(live.vaultPath, pagePath), "utf8"));
    expect(page.data["sensitivity"]).toBe("private");
    const tier = SENSITIVITY_ORDER[page.data["sensitivity"] as "private"];
    expect(page.data["sources"]).toContain(direct.event_id);
    for (const source of page.data["sources"] as string[]) {
      expect(SENSITIVITY_ORDER[eventHint(live, source)]).toBeLessThanOrEqual(tier);
    }
    const found = await serveSearch(live.agent("reader-public"), { query: "workshop" });
    expect(found.canon.map((chunk) => chunk.path)).not.toContain(pagePath);
    expect(JSON.stringify(found)).not.toContain(direct.event_id);
  });

  test("a typed-world relay is quoted in the stored claim and rewritten page", async () => {
    fixture = await serveFixture();
    const live = fixture;
    const world = await worldFixture(live.db);
    const original = getClaim(live.db, world.claims[2]!)!;
    const io = { db: live.db, vault_path: live.vaultPath };
    const receipt = applyCanonWrite(io, original, worldCanonTarget(live.db, original.claim_id), {
      writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
    });
    const ctx = live.agent("reader-private");
    const discovery = readWorldView(ctx, {
      operation: "find_concepts", label: world.label,
      valid: { kind: "all" }, knownAt: { kind: "current" },
    });
    if ("status" in discovery || discovery.result.status !== "current" || !("matches" in discovery.result.data)) {
      throw new Error("missing world discovery");
    }
    const ref = discovery.result.data.matches[0]!.ref;
    const card = readWorldView(ctx, {
      operation: "concept", concept: ref,
      valid: { kind: "all" }, knownAt: { kind: "current" },
    });
    if ("status" in card || card.result.status !== "current" || !("definitions" in card.result.data)) {
      throw new Error("missing world definition");
    }
    const relayed = await serveCorrect(ctx, {
      statement: "Use posterior odds after new evidence.",
      target: { world_claim: card.result.data.definitions[0]!.claim },
    });
    const correction = getClaim(live.db, relayed.data!.claim_id!)!;
    expect(correction.taint).toBe("quoted");
    expect(correction.frontmatter["x-relayed-by"]).toBe("agent:reader-private");
    expect(correction.sensitivity).toBe("private");
    expect(relayed.data!.rewritten.map((page) => page.page_path)).toEqual([receipt.page_path]);
    const page = parseFrontmatter(readFileSync(join(live.vaultPath, receipt.page_path), "utf8"));
    expect(page.data["taint"]).toBe("quoted");
    expect(page.data["sensitivity"]).toBe("private");
  });
});
