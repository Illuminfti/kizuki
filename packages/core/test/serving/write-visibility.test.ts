import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, setDefaultTimeout, test } from "bun:test";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import {
  applyCanonWrite,
  createBudgetTracker,
  resolveTarget,
} from "../../src/canon";
import { getClaim, insertClaim } from "../../src/claims/store";
import { rebuildDerived } from "../../src/derived";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { serveCorrect } from "../../src/serving/correct";
import { serveGetPage } from "../../src/serving/page";
import { servePropose } from "../../src/serving/propose";
import type { Envelope, ServeContext } from "../../src/serving/types";
import { claimInput } from "../claims/helpers";
import { serveFixture, storeEvent } from "./helpers";
import type { Fixture } from "./helpers";

setDefaultTimeout(120_000);

interface Filed {
  subject: string;
  predicate: string;
  object: string;
  hidden: boolean;
  confidence?: number;
  now?: string;
  valid_from?: string;
  valid_to?: string | null;
}

/** A keyed claim the public-ceiling agent can read (`hidden: false`) or cannot (`hidden: true`). */
async function file(f: Fixture, input: Filed): Promise<string> {
  const event = f.events[input.hidden ? "private" : "public"] as string;
  const stored = await insertClaim(
    {
      db: f.db,
      ...(input.now === undefined ? {} : { now: () => input.now as string }),
    },
    claimInput(event, {
      subject: input.subject,
      subjects: [input.subject],
      predicate: input.predicate,
      object: input.object,
      body: `${input.subject} ${input.predicate} ${input.object}.`,
      sensitivity: input.hidden ? "private" : "public",
      confidence: input.confidence ?? 0.7,
      ...(input.valid_from === undefined
        ? {}
        : { valid_from: input.valid_from }),
      ...(input.valid_to === undefined ? {} : { valid_to: input.valid_to }),
    }),
  );
  if (stored.outcome !== "stored" && stored.outcome !== "contested")
    throw new Error(`fixture claim: ${stored.outcome}`);
  return stored.outcome === "stored"
    ? stored.claim.claim_id
    : stored.incoming.claim_id;
}

// ---------------------------------------------------------------------------
// A1. correct: the rewrite diff is the whole page, whatever the caller may read
// ---------------------------------------------------------------------------

test("A1 correct does not return the text of a canon page above the caller's ceiling", async () => {
  const f = await serveFixture();
  try {
    const io = { db: f.db, vault_path: f.vaultPath };
    const write = async (
      predicate: string,
      object: string,
      body: string,
      event: string,
      sensitivity: "public" | "private",
    ) => {
      const filed = await insertClaim(
        { db: f.db },
        claimInput(event, {
          kind: "claim",
          frontmatter: { type: "fact", title: "About Linus" },
          subject: "person:linus",
          subjects: ["person:linus"],
          predicate,
          object,
          body,
          confidence: 1,
          sensitivity,
        }),
      );
      if (filed.outcome !== "stored") throw new Error(filed.outcome);
      const receipt = applyCanonWrite(
        io,
        filed.claim,
        resolveTarget(io, filed.claim),
        {
          writer: "loop",
          budget: createBudgetTracker({ canon_writes_per_run: 8 }),
        },
      );
      return { claim: filed.claim, receipt };
    };
    // One entity page accumulates a public reading and a private one; its label is the higher.
    const open = await write(
      "employment.works_at",
      "acme",
      "Linus works at acme.",
      f.events["public"] as string,
      "public",
    );
    const secret = await write(
      "health.metric",
      "PRIVATE-DIAGNOSIS-XYZ",
      "Linus has a private diagnosis: PRIVATE-DIAGNOSIS-XYZ.",
      f.events["private"] as string,
      "private",
    );
    expect(secret.receipt.page_path).toBe(open.receipt.page_path);

    const before = readFileSync(join(f.vaultPath, open.receipt.page_path), "utf8");
    const agent = f.agent("reader-public");
    // Precondition: the agent is refused this page everywhere it can ask.
    const direct = await serveGetPage(agent, { path: open.receipt.page_path });
    expect(direct.canon).toEqual([]);

    const envelope = await serveCorrect(agent, {
      statement: "Linus works at the workshop, not at acme.",
      target: { claim_id: open.claim.claim_id },
      object: "the workshop",
    });
    const wire = JSON.stringify(envelope);
    // The private line, the page's private label and its private evidence ids all ride in `rewritten[].diff`.
    expect(wire).not.toContain("PRIVATE-DIAGNOSIS-XYZ");
    expect(wire).not.toContain('sensitivity: \\"private\\"');
    expect(wire).not.toContain(f.events["private"] as string);
    expect(wire).not.toContain(open.receipt.page_path);
    expect(readFileSync(join(f.vaultPath, open.receipt.page_path), "utf8")).toBe(before);
  } finally {
    f.dispose();
  }
});

// ---------------------------------------------------------------------------
// A2. propose and correct answer differently when a claim the caller cannot read exists
// ---------------------------------------------------------------------------

async function proposeAs(
  f: Fixture,
  object: string,
  confidence = 0.5,
  predicate = "location.based_in",
) {
  const envelope = await servePropose(f.agent("reader-public"), {
    kind: "claim",
    target: `facts:probe-${predicate}-${object}`,
    body: `Ada: ${object}.`,
    subjects: ["person:ada"],
    subject: "person:ada",
    predicate,
    object,
    provenance: [f.events["public"] as string],
    confidence,
  });
  return envelope.data!;
}

test("A2a propose does not confirm a guess against a claim the agent cannot read", async () => {
  const f = await serveFixture();
  const control = await serveFixture();
  try {
    const hiddenId = await file(f, { subject: "person:ada", predicate: "location.based_in", object: "Lisbon", hidden: true });
    const right = await proposeAs(f, "Lisbon");
    const wrong = await proposeAs(f, "Oslo");
    // The same two guesses in a vault that holds no hidden claim.
    const rightControl = await proposeAs(control, "Lisbon");
    const wrongControl = await proposeAs(control, "Oslo");
    // A right guess is answered as a duplicate of the hidden claim, by its id; a wrong one as contested.
    expect(JSON.stringify(right)).not.toContain(hiddenId);
    expect([right.outcome, wrong.outcome]).toEqual([rightControl.outcome, wrongControl.outcome]);
  } finally {
    f.dispose();
    control.dispose();
  }
});

test("A2d a proposal aimed at a claim the agent cannot read does not raise or re-cite it", async () => {
  const f = await serveFixture();
  try {
    const hiddenId = await file(f, { subject: "person:ada", predicate: "location.based_in", object: "Lisbon", hidden: true, confidence: 0.3 });
    const before = getClaim(f.db, hiddenId)!;
    await proposeAs(f, "Lisbon", 0.99);
    const after = getClaim(f.db, hiddenId)!;
    // The agent's guess corroborated the private claim: its confidence, count and evidence moved.
    expect({ confidence: after.confidence, corroboration: after.corroboration, provenance: after.provenance }).toEqual({
      confidence: before.confidence,
      corroboration: before.corroboration,
      provenance: before.provenance,
    });
  } finally {
    f.dispose();
  }
});

test("A2b propose does not name, or retire, a hidden claim it outranks", async () => {
  const f = await serveFixture();
  try {
    const hiddenId = await file(f, {
      subject: "person:ada",
      predicate: "employment.role",
      object: "Director",
      hidden: true,
      confidence: 0.2,
    });
    const data = await proposeAs(f, "Engineer", 0.95, "employment.role");
    expect(JSON.stringify(data)).not.toContain(hiddenId);
    expect(data.superseded).toEqual([]);
    expect(getClaim(f.db, hiddenId)?.status).toBe("live");
  } finally {
    f.dispose();
  }
});

test("A2c correct does not list, count or retire a hidden peer of the claim it was aimed at", async () => {
  const f = await serveFixture();
  try {
    const open = await file(f, {
      subject: "person:ada",
      predicate: "employment.works_at",
      object: "Acme",
      hidden: false,
    });
    const hiddenId = await file(f, {
      subject: "person:ada",
      predicate: "employment.works_at",
      object: "Beta-Secret-Labs",
      hidden: true,
    });
    const envelope = await serveCorrect(f.agent("reader-public"), {
      statement: "Ada works at Globex.",
      target: { claim_id: open },
      object: "Globex",
    });
    expect(JSON.stringify(envelope)).not.toContain(hiddenId);
    expect(envelope.data?.answer).toContain("retired 1 claim(s)");
    expect(getClaim(f.db, hiddenId)?.status).toBe("live");
  } finally {
    f.dispose();
  }
});

// ---------------------------------------------------------------------------
// A3. search: the index is over raw text, so a redacted value can be read back by prefix
// ---------------------------------------------------------------------------

test("A3 a scoped agent cannot recover a redacted secret one prefix at a time through search", async () => {
  const f = await serveFixture();
  try {
    const secret = ["zk7q", "9xm2"].join("");
    const eventId = storeEvent(
      f.db,
      "rec-oracle",
      "2026-02-28T10:45:00Z",
      `wifi note password=${secret} written on the fridge`,
      "person:ada",
      "public",
    );
    rebuildDerived(f.db, f.vaultPath);
    const { token } = addAgent(f.db, "prober", {
      ...OWNER_AGENT_GRANT,
      ceiling: "public",
      tools: ["search"],
      rate_limit_per_minute: 1000,
    });
    const principal = authenticate(f.db, token);
    if (principal === null) throw new Error("prober did not authenticate");
    const ctx: ServeContext = { db: f.db, vaultPath: f.vaultPath, principal };
    const ask = (query: string) =>
      dispatchServeTool(ctx, "search", {
        query,
        scope: "ledger",
        limit: 5,
      }) as Promise<Envelope<unknown>>;

    // The served text is redacted: the value itself is not in the answer.
    const shown = await ask("wifi");
    expect(JSON.stringify(shown)).toContain("[redacted:secret_assignment]");
    expect(JSON.stringify(shown)).not.toContain(secret);

    // The attack: ask whether the event matches `password <prefix>*`, extending the prefix one character at a time.
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let known = "";
    let queries = 0;
    while (known.length < secret.length) {
      let next: string | null = null;
      for (const character of alphabet) {
        queries += 1;
        const answer = await ask(`"password ${known}${character}*"`);
        if (answer.quoted.some((chunk) => chunk.event_id === eventId)) {
          next = character;
          break;
        }
      }
      if (next === null) break;
      known += next;
    }
    expect(queries).toBeLessThan(1000);
    expect(known).toBe("");
  } finally {
    f.dispose();
  }
});

