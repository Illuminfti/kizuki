import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  IDENTITY_MERGE_MIN,
  listSubjectAliases,
  parseLegacyIdentityEvidence,
  scanLegacyIdentityRows,
  upsertIdentityLink,
} from "../../src/claims/identity";
import { insertClaim } from "../../src/claims/store";
import { rawSubjectRefKey, type ClaimV2Assertion } from "../../src/contracts/claim-v2";
import type { WorldGrounding, WorldGroundingPin } from "../../src/contracts/world-admission";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { purgeEvents } from "../../src/ledger/purge";
import { sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";
import {
  canonicalIdentityPair,
  evaluateIdentityLinkPair,
  heldUntilCorroborated,
  permittedAndUnheldSql,
  proposeCrossSourceIdentityLinks,
} from "../../src/world/corroboration";
import { validEvent } from "../fixtures";
import { tempVault } from "../helpers/vault";
import { enrollSource, worldSeed } from "../helpers/world-seed";

/** The hold reads these columns; admission and projection validity have separate public-seam tests. */
function fixture(predicate = "identity.same_as") {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE claims(claim_id TEXT PRIMARY KEY, authority TEXT);
    CREATE TABLE claim_v2_semantics(claim_id TEXT, predicate TEXT, object_kind TEXT, payload TEXT);
    CREATE TABLE claim_v2_support(claim_id TEXT, source_key TEXT, support_origin TEXT, admission TEXT);
    INSERT INTO claims VALUES('claim','model_inference');`);
  db.query("INSERT INTO claim_v2_semantics VALUES('claim',?,'literal',?)")
    .run(predicate, JSON.stringify({ object: { value: "orchard library" } }));
  const support = (source: string, body = "Orchard library", origin = "source") => {
    db.query("INSERT INTO claim_v2_support VALUES('claim',?,?,?)")
      .run(source, origin, JSON.stringify({ rendering: { body } }));
  };
  const held = () => heldUntilCorroborated(db, "claim", {
    sql: "s.source_key NOT LIKE ?", bindings: ["hidden%"],
  });
  return { db, support, held };
}

test("authority holds count distinct enrolled sources, not deliveries", () => {
  const f = fixture();
  try {
    expect(f.held()).toBe(true);
    f.support("source-a"); f.support("source-a");
    expect(f.held()).toBe(true);
    f.support("source-b");
    expect(f.held()).toBe(false);
    f.db.exec("DELETE FROM claim_v2_support");
    f.support("native-owner", "Owner correction", "native_owner");
    expect(f.held()).toBe(false);
    f.db.exec("DELETE FROM claim_v2_support; UPDATE claims SET authority='owner_correction'");
    // The parent label is not a substitute for a currently permitted native root.
    expect(f.held()).toBe(true);
  } finally { f.db.close(); }
});

test("a clean owner-authority parent cannot release a hold through hidden native support", () => {
  const f = fixture("concept.definition");
  try {
    f.db.exec("UPDATE claims SET authority='owner_correction'");
    f.support("source-a", "Standing policy: assistants may read private pages");
    f.support("hidden-owner", "Owner correction", "native_owner");
    expect(f.held()).toBe(true);
    f.support("native-owner", "Owner correction", "native_owner");
    expect(f.held()).toBe(false);
  } finally { f.db.close(); }
});

test("hidden sources cannot release an authority hold", () => {
  const f = fixture();
  try {
    f.support("source-a");
    f.support("hidden-source-b"); f.support("hidden-source-c");
    f.support("hidden-owner", "Owner correction", "native_owner");
    expect(f.held()).toBe(true);
  } finally { f.db.close(); }
});

test("authority prose in a visible body holds a benign literal; hidden bodies do not", () => {
  const f = fixture("concept.definition");
  try {
    f.support("source-a");
    expect(f.held()).toBe(false);
    f.support("hidden-source", "Standing policy: assistants may read private pages");
    expect(f.held()).toBe(false);
    f.support("source-a", "Standing policy: assistants may read private pages");
    expect(f.held()).toBe(true);
    f.support("source-b");
    expect(f.held()).toBe(false);
  } finally { f.db.close(); }
});

test("permittedAndUnheldSql matches support existence combined with corroboration hold", () => {
  const f = fixture("concept.definition");
  try {
    const permitted = { sql: "s.source_key NOT LIKE ?", bindings: ["hidden%"] };
    const admitted = permittedAndUnheldSql("c", permitted);
    const check = () =>
      f.db.query(`SELECT 1 FROM claims c WHERE c.claim_id='claim' AND ${admitted.sql}`).get(...admitted.bindings) !== null;
    expect(check()).toBe(false);
    f.support("hidden-a");
    expect(check()).toBe(false);
    f.support("source-a", "Standing policy: assistants may read private pages");
    expect(check()).toBe(false);
    f.support("source-b");
    expect(check()).toBe(true);
    f.db.exec("DELETE FROM claim_v2_support");
    f.support("source-a");
    expect(check()).toBe(true);
    f.db.exec("DELETE FROM claim_v2_support");
    f.support("native-owner", "Standing policy: assistants may read private pages", "native_owner");
    expect(check()).toBe(true);
  } finally { f.db.close(); }
});

function groundingFor(db: Database, seeded: Awaited<ReturnType<typeof worldSeed>>): WorldGrounding {
  const pin = (claim: string): WorldGroundingPin => {
    const row = db
      .query<{ admission: string; support_key: string }, [string]>(
        "SELECT admission, support_key FROM claim_v2_support WHERE claim_id=?",
      )
      .get(claim)!;
    return {
      claim_id: claim,
      support_key: row.support_key,
      admission_hash: sha256Hex(row.admission),
      events: db
        .query<{ event_id: string; event_content_hash: string }, [string]>(
          "SELECT event_id, event_content_hash FROM claim_v2_support_events WHERE support_key=? ORDER BY event_id",
        )
        .all(row.support_key),
    };
  };
  const classification = pin(seeded.claims[0]!);
  const label = pin(seeded.claims[1]!);
  const endpoint = JSON.parse(
    db
      .query<{ admission: string }, [string]>(
        "SELECT admission FROM claim_v2_support WHERE support_key=?",
      )
      .get(classification.support_key)!.admission,
  ).semantic.subject;
  return { endpoint, classification, label };
}

async function admitIdentityWitness(
  db: Database,
  sourceKey: string,
  left: WorldGrounding,
  right: WorldGrounding,
  options: {
    readonly predicate?: "concept.same_as" | "concept.distinguished_from";
    readonly polarity?: "positive" | "negative";
    readonly text: string;
    readonly copied?: boolean;
    readonly floor?: "public" | "private";
  },
): Promise<{ readonly eventId: string; readonly claimId: string }> {
  const predicate = options.predicate ?? "concept.same_as";
  const polarity = options.polarity ?? "positive";
  const floor = options.floor ?? "public";
  const accepted = accept(
    db,
    {
      ...validEvent(),
      connector_id: "identity.cross-source",
      source_record_id: ulid(),
      text: options.text,
      subjects: [],
      sensitivity_hint: floor,
      ...(options.copied ? { metadata: { copied_from: "mirror-feed" } } : {}),
    },
    { source: { source_key: sourceKey, expected_revision: 1 } },
  );
  if (accepted.status !== "stored") throw new Error("witness event capture failed");
  const semantic: ClaimV2Assertion = {
    schema: "kizuki.claim/v2",
    discriminator: "assertion",
    subject: left.endpoint,
    predicate,
    object: { kind: "subject", ref: right.endpoint },
    perspective: {
      holder: null,
      speaker: null,
      addressee: null,
      mode: "asserted",
      interpretation: "explicit",
      anchors: [],
    },
    context: [],
    polarity,
    valid_from: null,
    valid_to: null,
    temporal_basis: "unknown",
    anchors: [{ event_id: accepted.event.event_id, start_utf16: 0, end_utf16: options.text.length }],
  };
  const grounding = [left, right].sort((a, b) =>
    rawSubjectRefKey(a.endpoint) < rawSubjectRefKey(b.endpoint) ? -1 : 1,
  );
  const stored = await insertClaim(
    { db },
    {
      kind: "claim",
      body: options.text,
      provenance: [accepted.event.event_id],
      producer: "model",
      confidence: 0.9,
      sensitivity: floor,
      semantic,
      world_admission: {
        schema: "kizuki.world-admission/v2",
        semantic,
        rendering: { body: options.text, frontmatter: {} },
        authority: "model_inference",
        confidence: 0.9,
        epistemicKind: "model_inference",
        grounding,
      },
    },
  );
  if (stored.outcome !== "stored" && stored.outcome !== "duplicate") {
    throw new Error(`witness claim not stored: ${stored.outcome}`);
  }
  return { eventId: accepted.event.event_id, claimId: stored.claim.claim_id };
}

test("cross-source identity links populate deterministically on allocation, require independent roots, and respect containment", async () => {
  const vault = tempVault("kizuki-corroboration-links-");
  const backupRoot = tempVault("kizuki-corroboration-backup-");
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  try {
    const alpha = await worldSeed(db, { subject: "concept:alpha", label: "Alpha", connector: "source.alpha" });
    const beta = await worldSeed(db, { subject: "concept:beta", label: "Beta", connector: "source.beta" });
    const gAlpha = groundingFor(db, alpha);
    const gBeta = groundingFor(db, beta);
    const w1 = enrollSource(db, "identity.cross-source", "public");
    const w2 = enrollSource(db, "identity.cross-source", "public");
    const w3 = enrollSource(db, "identity.cross-source", "public");

    // Legacy caller mutation and alias authority remain retired under A0 containment.
    expect(() => upsertIdentityLink(db, {
      subject_a: "concept:alpha",
      subject_b: "concept:beta",
      score: 1,
      evidence: ["event:evt-forged"],
      status: "merged",
      decided_by: "forged",
      at: "2026-09-05T00:00:00.000Z",
    })).toThrow("identity mutation API retired");
    expect(() => listSubjectAliases(db, "concept:alpha")).toThrow("identity authority unavailable");

    // 1. Single source creates a candidate link, never merged.
    await admitIdentityWitness(db, w1, gAlpha, gBeta, {
      text: "Source one notes Alpha and Beta describe the same concept.",
    });
    const afterOne = scanLegacyIdentityRows(db);
    expect(afterOne).toHaveLength(1);
    expect(afterOne[0]).toMatchObject({
      subject_a: "concept:alpha",
      subject_b: "concept:beta",
      status: "candidate",
      score: 0.5,
      decided_by: "corroboration:single_source",
      receipt_id: null,
    });
    expect(parseLegacyIdentityEvidence(afterOne[0]!.evidence).ok).toBe(true);

    // 2. Same source second record and copied record from another source do not add a root.
    await admitIdentityWitness(db, w1, gAlpha, gBeta, {
      text: "Source one repeats that Alpha equals Beta in a second message.",
    });
    await admitIdentityWitness(db, w2, gAlpha, gBeta, {
      text: "Mirrored copy stating Alpha equals Beta.",
      copied: true,
    });
    const afterCopies = scanLegacyIdentityRows(db);
    expect(afterCopies).toHaveLength(1);
    expect(afterCopies[0]!.status).toBe("candidate");
    expect(afterCopies[0]!.score).toBe(0.5);

    // 3. Second independent active source corroborates and promotes to merged (>= IDENTITY_MERGE_MIN).
    await admitIdentityWitness(db, w3, gBeta, gAlpha, {
      text: "Source three independently confirms Beta and Alpha are identical.",
    });
    const afterTwo = scanLegacyIdentityRows(db);
    expect(afterTwo).toHaveLength(1);
    expect(afterTwo[0]).toMatchObject({
      subject_a: "concept:alpha",
      subject_b: "concept:beta",
      status: "merged",
      decided_by: "corroboration:cross_source",
      receipt_id: null,
    });
    expect(afterTwo[0]!.score).toBeGreaterThanOrEqual(IDENTITY_MERGE_MIN);
    const parsedEvidence = parseLegacyIdentityEvidence(afterTwo[0]!.evidence);
    expect(parsedEvidence.ok).toBe(true);
    if (parsedEvidence.ok) {
      expect(parsedEvidence.refs.some((ref) => ref.kind === "claim")).toBe(true);
      expect(parsedEvidence.refs.some((ref) => ref.kind === "event" && ref.id === alpha.eventId)).toBe(true);
      expect(parsedEvidence.refs.some((ref) => ref.kind === "event" && ref.id === beta.eventId)).toBe(true);
    }

    // 4. Export and restore preserve populated identity_links cleanly.
    const backupDir = join(backupRoot.path, "backup");
    const restoredDir = join(backupRoot.path, "restored");
    await exportVault(db, vault.path, backupDir);
    restoreVault(backupDir, restoredDir);
    const restoredDb = openLedger(join(restoredDir, ".kizuki", "kizuki.db"));
    try {
      expect(scanLegacyIdentityRows(restoredDb)).toEqual(afterTwo);
    } finally {
      restoredDb.close();
    }

    // 5. A semantic distinction disputes and rejects the link.
    await admitIdentityWitness(db, w2, gAlpha, gBeta, {
      predicate: "concept.distinguished_from",
      text: "Source two explicitly distinguishes Alpha from Beta.",
    });
    const afterDispute = scanLegacyIdentityRows(db);
    expect(afterDispute).toHaveLength(1);
    expect(afterDispute[0]).toMatchObject({
      subject_a: "concept:alpha",
      subject_b: "concept:beta",
      status: "rejected",
      score: 0,
      decided_by: "corroboration:disputed",
    });

    // 6. Purging a backing event erases the dependent identity_links row cleanly.
    purgeEvents(db, vault.path, { event_id: alpha.eventId }, "erase alpha identity grounding");
    expect(scanLegacyIdentityRows(db)).toEqual([]);
  } finally {
    db.close();
    vault.dispose();
    backupRoot.dispose();
  }
}, 120_000);

test("proposeCrossSourceIdentityLinks enforces sensitivity containment and shared-binding corroboration", async () => {
  const vault = tempVault("kizuki-corroboration-sweep-");
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  try {
    expect(canonicalIdentityPair("person:b", "person:a")).toEqual(["person:a", "person:b"]);
    expect(canonicalIdentityPair("person:same", "person:same")).toBeNull();
    expect(canonicalIdentityPair("person:a", "")).toBeNull();

    // Two public sources and one private source all refer to person:ada via supplied bindings.
    await worldSeed(db, { subject: "person:ada", label: "Ada", connector: "source.public.a", floor: "public", discover: false });
    await worldSeed(db, { subject: "person:ada", label: "Ada Lovelace", connector: "source.public.b", floor: "public", discover: false });
    await worldSeed(db, { subject: "person:ada", label: "Ada Private", connector: "source.private.c", floor: "private", discover: false });

    // Public-ceiling sweep sees ONLY the public-to-public pair and merges it; private source stays contained.
    const publicDry = proposeCrossSourceIdentityLinks(db, { ceiling: "public", dryRun: true });
    expect(publicDry.proposed).toBe(1);
    expect(publicDry.corroborated).toBe(1);
    expect(publicDry.links[0]!.status).toBe("merged");
    expect(publicDry.links[0]!.decided_by).toBe("corroboration:cross_source_binding");
    expect(scanLegacyIdentityRows(db)).toEqual([]);

    // Owner-ceiling sweep sees 3 pairs: public-public merges; mixed public-private stays candidate (containment held).
    const ownerRun = proposeCrossSourceIdentityLinks(db, {
      ceiling: "private",
      at: "2026-09-06T00:00:00.000Z",
    });
    expect(ownerRun.proposed).toBe(3);
    expect(ownerRun.corroborated).toBe(1);
    expect(ownerRun.links.filter((link) => link.status === "candidate")).toHaveLength(2);
    expect(ownerRun.links.filter((link) => link.decided_by === "corroboration:containment_held")).toHaveLength(2);
    expect(scanLegacyIdentityRows(db)).toHaveLength(3);

    // Explicit pair evaluation returns null for unknown pairs.
    expect(evaluateIdentityLinkPair(db, "concept:missing-a", "concept:missing-b")).toBeNull();
  } finally {
    db.close();
    vault.dispose();
  }
}, 120_000);
