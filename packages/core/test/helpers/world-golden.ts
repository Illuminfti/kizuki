/**
 * Golden scenes for the world read path.
 *
 * A scene is a real ledger with a small, fully synthetic world in it. A reader
 * makes the same `world_view` calls a client makes and the trace of what it
 * saw is compared with a file, byte for byte. Wire tokens are random, so a
 * token is replaced by the order in which it first appears; every other byte,
 * including key order, is kept exactly as served.
 *
 * Set KIZUKI_UPDATE_GOLDEN=1 to rewrite the files a run compares against.
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  OWNER,
  OWNER_AGENT_GRANT,
  addAgent,
  authenticate,
} from "../../src/agents";
import { insertClaim } from "../../src/claims/store";
import type {
  ClaimV2Assertion,
  ClaimV2Object,
} from "../../src/contracts/claim-v2";
import { WORLD_ADMISSION_SCHEMA } from "../../src/contracts/world-admission";
import { initGraph } from "../../src/graph/schema";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { initSearch } from "../../src/search/schema";
import type { ServeContext } from "../../src/serving/types";
import { serveWorldView } from "../../src/serving/world-view";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { enrollSource, worldSeed } from "./world-seed";
import { tempVault } from "./vault";

export const CONNECTOR = "world.fixture";
export const VISIBLE_SUBJECTS = [
  "topic:bayes",
  "topic:probability",
  "project:launch",
  "project:archive",
  "person:ada",
] as const;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const GOLDEN_DIR = join(import.meta.dir, "..", "world", "golden");

/** Serialized as served (insertion order kept), with each wire token (and page cursor, which is one) named by first appearance. */
export function goldenText(value: unknown): string {
  const seen = new Map<string, number>();
  const walk = (item: unknown, key: string | null): unknown => {
    if (Array.isArray(item)) return item.map((entry) => walk(entry, null));
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([name, entry]) => [
          name,
          walk(entry, name),
        ]),
      );
    }
    if ((key === "token" || key === "cursor") && typeof item === "string" && TOKEN.test(item)) {
      if (!seen.has(item)) seen.set(item, seen.size);
      return `<token ${seen.get(item)}>`;
    }
    return item;
  };
  return `${JSON.stringify(walk(value, null), null, 2)}\n`;
}

export function expectGolden(name: string, value: unknown): string | null {
  const path = join(GOLDEN_DIR, `${name}.json`);
  const text = goldenText(value);
  if (process.env.KIZUKI_UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return null;
  }
  if (!existsSync(path))
    return `golden file ${name}.json is missing; run with KIZUKI_UPDATE_GOLDEN=1 to create it`;
  return readFileSync(path, "utf8") === text ? null : text;
}

export interface WireObjectRef {
  readonly kind: "object";
  readonly token: string;
}

/** One reader: every call is recorded under its name, in order, exactly as served. */
export function goldenReader(ctx: ServeContext) {
  const trace: Record<string, unknown> = {};
  const call = (name: string, input: Record<string, unknown>): unknown => {
    const data = serveWorldView(ctx, {
      valid: { kind: "all" },
      knownAt: { kind: "current" },
      ...input,
    }).data;
    trace[name] = data;
    return data;
  };
  const matches = (
    data: unknown,
  ): { ref: WireObjectRef; labels: string[] }[] => {
    const result = (data as { result?: { data?: { matches?: unknown } } })
      .result;
    return (
      (result?.data?.matches as
        { ref: WireObjectRef; labels: string[] }[] | undefined) ?? []
    );
  };
  return {
    trace,
    call,
    matches,
    find(
      name: string,
      operation: "find_concepts" | "find_situations",
      label: string,
      extra: Record<string, unknown> = {},
    ) {
      return matches(call(name, { operation, label, ...extra }));
    },
    card(
      name: string,
      operation: "concept" | "situation",
      ref: WireObjectRef,
      extra: Record<string, unknown> = {},
    ) {
      return call(name, { operation, [operation]: ref, ...extra });
    },
  };
}

interface ClaimSpec {
  readonly subject: string;
  /** Subjects the event names besides the claim's own; a reference to another subject must be one of them. */
  readonly also?: readonly string[];
  readonly predicate: string;
  readonly object: ClaimV2Object;
  readonly mode?: "asserted" | "hypothetical";
  readonly polarity?: "positive" | "negative";
  readonly text: string;
}

/** One claim from its own event, for shapes `worldSeed` does not write (a person's learning facet, a hedged statement). */
export async function addClaim(
  db: Database,
  sourceKey: string,
  spec: ClaimSpec,
): Promise<{ eventId: string; claimId: string }> {
  const accepted = accept(
    db,
    {
      ...validEvent(),
      connector_id: CONNECTOR,
      source_record_id: ulid(),
      kind: "note",
      text: spec.text,
      sensitivity_hint: "public",
      subjects: [spec.subject, ...(spec.also ?? [])].map((subject_id) => ({ subject_id, role: "about" as const })),
    },
    { source: { source_key: sourceKey, expected_revision: 1 } },
  );
  if (accepted.status !== "stored")
    throw new Error(`event was not stored: ${JSON.stringify(accepted)}`);
  const event = accepted.event;
  const semantic: ClaimV2Assertion = {
    schema: "kizuki.claim/v2",
    discriminator: "assertion",
    subject: {
      kind: "supplied",
      id: spec.subject,
      namespace: { connector_id: CONNECTOR, source_key: sourceKey },
    },
    predicate: spec.predicate,
    object: spec.object,
    perspective: {
      holder: null,
      speaker: null,
      addressee: null,
      mode: spec.mode ?? "asserted",
      interpretation: "explicit",
      anchors: [],
    },
    context: [],
    polarity: spec.polarity ?? "positive",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    temporal_basis: "explicit",
    anchors: [
      { event_id: event.event_id, start_utf16: 0, end_utf16: spec.text.length },
    ],
  };
  const body = `${spec.predicate}: ${JSON.stringify(spec.object)}`;
  const stored = await insertClaim(
    { db },
    {
      kind: "claim",
      body,
      provenance: [event.event_id],
      producer: "deterministic",
      confidence: 0.8,
      sensitivity: "public",
      subjects: [spec.subject],
      semantic,
      world_admission: {
        schema: WORLD_ADMISSION_SCHEMA,
        semantic,
        rendering: { body, frontmatter: {} },
        authority: "model_inference",
        confidence: 0.5,
        epistemicKind: "model_inference",
      },
    },
  );
  if (stored.outcome !== "stored")
    throw new Error(`${spec.predicate} was ${stored.outcome}`);
  return { eventId: event.event_id, claimId: stored.claim.claim_id };
}

export const subjectRef = (id: string, sourceKey: string): ClaimV2Object => ({
  kind: "subject",
  ref: {
    kind: "supplied",
    id,
    namespace: { connector_id: CONNECTOR, source_key: sourceKey },
  },
});

export interface GoldenScene {
  readonly db: Database;
  readonly vaultPath: string;
  readonly owner: ServeContext;
  /** Public ceiling, and only the subjects the public source is about. */
  readonly narrow: ServeContext;
  readonly publicSource: string;
  /** The one event behind the extra example, so a scene can purge it. */
  readonly extraEventId: string;
  dispose(): void;
}

/**
 * A public source with a Concept (definition, example, a negative statement,
 * a hedged one, a required Concept, a learning facet), two Situations (one
 * clean, one contested), and a private source the narrow reader cannot see.
 */
export async function goldenScene(): Promise<GoldenScene> {
  const vault = tempVault("kizuki-golden-");
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  try {
    initSearch(db);
    initGraph(db);
    const publicSource = enrollSource(db, CONNECTOR, "public");
    await worldSeed(db, {
      sourceKey: publicSource,
      subject: "topic:probability",
      label: "Probability",
      discover: false,
    });
    await worldSeed(db, {
      sourceKey: publicSource,
      subject: "topic:bayes",
      label: "Bayesian updating",
      discover: false,
      predicates: [
        {
          predicate: "concept.definition",
          object: { kind: "literal", value: "Revise beliefs using evidence" },
        },
        {
          predicate: "concept.example",
          object: {
            kind: "literal",
            value: "Update a coin bias after each flip",
          },
        },
        {
          predicate: "concept.counterexample",
          object: { kind: "literal", value: "Ignoring the base rate" },
          polarity: "negative",
        },
      ],
      perspectiveEvidence: true,
    });
    await addClaim(db, publicSource, {
      subject: "topic:bayes",
      predicate: "concept.example",
      object: {
        kind: "literal",
        value: "Maybe medical screening works this way",
      },
      mode: "hypothetical",
      text: "Maybe medical screening works this way.",
    });
    await addClaim(db, publicSource, {
      subject: "topic:bayes",
      also: ["topic:probability"],
      predicate: "concept.requires",
      object: subjectRef("topic:probability", publicSource),
      text: "Bayesian updating requires probability.",
    });
    await addClaim(db, publicSource, {
      subject: "person:ada",
      also: ["topic:bayes"],
      predicate: "learning.exposure",
      object: subjectRef("topic:bayes", publicSource),
      text: "Ada read about Bayesian updating.",
    });
    await worldSeed(db, {
      kind: "situation",
      sourceKey: publicSource,
      subject: "project:launch",
      label: "Launch plan",
      discover: false,
      predicates: [
        {
          predicate: "situation.objective",
          object: { kind: "literal", value: "Ship the first release" },
        },
        {
          predicate: "situation.blocker",
          object: { kind: "literal", value: "Waiting on the review" },
        },
        {
          predicate: "situation.change",
          object: { kind: "literal", value: "Scope was cut in half" },
        },
        {
          predicate: "situation.commitment",
          object: { kind: "literal", value: "Ada owns the checklist" },
        },
        {
          predicate: "situation.commitment",
          object: { kind: "literal", value: "Ben owns the announcement" },
        },
      ],
    });
    await addClaim(db, publicSource, {
      subject: "project:launch",
      also: ["person:ada"],
      predicate: "situation.participant",
      object: subjectRef("person:ada", publicSource),
      text: "Ada is on the launch.",
    });
    await worldSeed(db, {
      kind: "situation",
      sourceKey: publicSource,
      subject: "project:archive",
      label: "Archive plan",
      discover: false,
      predicates: [
        {
          predicate: "situation.objective",
          object: { kind: "literal", value: "Move old notes out" },
        },
        {
          predicate: "situation.objective",
          object: { kind: "literal", value: "Delete old notes" },
        },
        {
          predicate: "situation.blocker",
          object: { kind: "literal", value: "No backup exists" },
          polarity: "negative",
        },
      ],
    });
    const extra = await worldSeed(db, {
      sourceKey: publicSource,
      subject: "topic:bayes",
      label: "Bayesian updating",
      discover: false,
      predicates: [
        {
          predicate: "concept.example",
          object: { kind: "literal", value: "Spam filtering" },
        },
      ],
    });
    await worldSeed(db, {
      subject: "topic:hidden",
      label: "Bayesian priors",
      floor: "private",
      discover: false,
    });
    const agent = addAgent(db, "narrow-reader", {
      ...OWNER_AGENT_GRANT,
      ceiling: "public",
      subjects: [...VISIBLE_SUBJECTS],
    });
    const principal = authenticate(db, agent.token);
    if (principal === null)
      throw new Error("the narrow reader did not authenticate");
    const base = { db, vaultPath: vault.path };
    return {
      db,
      vaultPath: vault.path,
      owner: { ...base, principal: OWNER },
      narrow: { ...base, principal },
      publicSource,
      extraEventId: extra.eventId,
      dispose() {
        db.close();
        vault.dispose();
      },
    };
  } catch (error) {
    db.close();
    vault.dispose();
    throw error;
  }
}
