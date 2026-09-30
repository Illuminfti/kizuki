/**
 * A small synthetic world for the correction workstream: any claim shape the
 * shared writer admits (negative, roled, contexted, quoted, node-object), one
 * source, an owner context, and the two steps every correction test repeats,
 * reading a card to obtain opaque claim tokens and writing the world page so a
 * correction has a canon receipt to undo.
 *
 * Every id is a supplied reference in one source namespace, so a test names
 * endpoints by plain strings. Every endpoint a claim names is a subject of the
 * event that anchors it, which is what source admission requires.
 */
import type { Database } from "bun:sqlite";
import { OWNER } from "../../src/agents";
import { applyCanonWrite } from "../../src/canon/apply";
import { worldCanonTarget } from "../../src/canon/world-materialization";
import { getClaim, insertClaim } from "../../src/claims/store";
import {
  rawSubjectRefKey,
  type ClaimV2Assertion,
  type ClaimV2Object,
  type ClaimV2Perspective,
  type RawSubjectRef,
} from "../../src/contracts/claim-v2";
import { WORLD_ADMISSION_SCHEMA } from "../../src/contracts/world-admission";
import { accept } from "../../src/ledger/ledger";
import {
  readWorldView,
  type WorldReadResult,
} from "../../src/serving/world-view";
import type { ServeContext } from "../../src/serving/types";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { budget } from "../canon/helpers";
import { enrollSource } from "./world-seed";

const CONNECTOR = "world.correct";
const TEXT = "Synthetic record used to anchor one world assertion.";
const SPAN = { start_utf16: 0, end_utf16: 9 } as const;

export type CorrectionObjectSpec =
  | { readonly literal: string }
  | { readonly subject: string }
  | { readonly vocabulary: string };

export interface AssertionSpec {
  readonly subject: string;
  readonly predicate: string;
  readonly object: CorrectionObjectSpec;
  readonly polarity?: "positive" | "negative";
  readonly mode?: ClaimV2Perspective["mode"];
  readonly holder?: string;
  readonly speaker?: string;
  readonly addressee?: string;
  readonly context?: readonly string[];
}

export interface WorldRef {
  readonly kind: "object";
  readonly token: string;
}
export interface ClaimRef {
  readonly kind: "claim";
  readonly token: string;
}

export interface CorrectionKit {
  readonly db: Database;
  readonly vaultPath: string;
  readonly sourceKey: string;
  /** The owner, with a vault path so canon writes work. */
  readonly ctx: ServeContext;
  ref(id: string): RawSubjectRef;
  /** Store one assertion through the shared writer and return its claim id. */
  write(spec: AssertionSpec): Promise<string>;
  /** `world.kind` and the label predicate of a kind: enough for a card to exist. */
  declare(
    kind: "concept" | "situation",
    id: string,
    label: string,
  ): Promise<readonly string[]>;
  /** Write the world page of a subject from its live, unreceipted claims. */
  materialize(subject: string): void;
  /** The object ref the principal holds for a label of a kind. */
  find(
    ctx: ServeContext,
    kind: "concept" | "situation",
    label: string,
  ): WorldRef;
  /** The full read of one card. */
  card(
    ctx: ServeContext,
    kind: "concept" | "situation",
    ref: WorldRef,
  ): Record<string, any>;
  read(ctx: ServeContext, input: Record<string, unknown>): WorldReadResult;
}

function valid(): Record<string, unknown> {
  return { valid: { kind: "all" }, knownAt: { kind: "current" } };
}

/** The unwrapped data of a current or incomplete world_view answer. */
export function worldData(result: WorldReadResult): Record<string, any> {
  if ("status" in result || result.result.status === "unavailable")
    throw new Error("world view unavailable");
  return result.result.data as unknown as Record<string, any>;
}

export interface CorrectionKitOptions {
  /** Write into a source that is already enrolled, so a fixture and the kit share subjects and pages. */
  readonly source?: { readonly connector: string; readonly sourceKey: string };
}

export function correctionKit(db: Database, vaultPath: string, options: CorrectionKitOptions = {}): CorrectionKit {
  const connector = options.source?.connector ?? CONNECTOR;
  const sourceKey = options.source?.sourceKey ?? enrollSource(db, CONNECTOR, "public");
  const namespace = { connector_id: connector, source_key: sourceKey };
  const ref = (id: string): RawSubjectRef => ({
    kind: "supplied",
    id,
    namespace,
  });
  const ctx: ServeContext = { db, vaultPath, principal: OWNER };
  const bySubject = new Map<string, string[]>();

  async function write(spec: AssertionSpec): Promise<string> {
    const ids = [
      ...new Set([
        spec.subject,
        ...("subject" in spec.object ? [spec.object.subject] : []),
        ...(spec.holder === undefined ? [] : [spec.holder]),
        ...(spec.speaker === undefined ? [] : [spec.speaker]),
        ...(spec.addressee === undefined ? [] : [spec.addressee]),
        ...(spec.context ?? []),
      ]),
    ];
    const accepted = accept(
      db,
      {
        ...validEvent(),
        connector_id: connector,
        source_record_id: ulid(),
        kind: "note",
        text: TEXT,
        sensitivity_hint: "public",
        subjects: ids.map((subject_id) => ({
          subject_id,
          role: "about" as const,
        })),
      },
      { source: { source_key: sourceKey, expected_revision: 1 } },
    );
    if (accepted.status !== "stored")
      throw new Error(`event was not stored: ${JSON.stringify(accepted)}`);
    const anchor = { event_id: accepted.event.event_id, ...SPAN };
    const roles = spec.holder !== undefined || spec.speaker !== undefined || spec.addressee !== undefined;
    const object: ClaimV2Object =
      "literal" in spec.object
        ? { kind: "literal", value: spec.object.literal }
        : "vocabulary" in spec.object
          ? {
              kind: "vocabulary",
              ref: { kind: "vocabulary", id: spec.object.vocabulary },
            }
          : { kind: "subject", ref: ref(spec.object.subject) };
    const semantic: ClaimV2Assertion = {
      schema: "kizuki.claim/v2",
      discriminator: "assertion",
      subject: ref(spec.subject),
      predicate: spec.predicate,
      object,
      perspective: {
        holder: spec.holder === undefined ? null : ref(spec.holder),
        speaker: spec.speaker === undefined ? null : ref(spec.speaker),
        addressee: spec.addressee === undefined ? null : ref(spec.addressee),
        mode: spec.mode ?? "asserted",
        interpretation: "explicit",
        anchors: roles ? [anchor] : [],
      },
      context: (spec.context ?? [])
        .map(ref)
        .sort((a, b) => (rawSubjectRefKey(a) < rawSubjectRefKey(b) ? -1 : 1)),
      polarity: spec.polarity ?? "positive",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_to: null,
      temporal_basis: "explicit",
      anchors: [anchor],
    };
    const body = `${spec.predicate}: ${JSON.stringify(spec.object)}`;
    const stored = await insertClaim(
      { db },
      {
        kind: "claim",
        body,
        provenance: [accepted.event.event_id],
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
    bySubject.set(spec.subject, [
      ...(bySubject.get(spec.subject) ?? []),
      stored.claim.claim_id,
    ]);
    return stored.claim.claim_id;
  }

  const read = (as: ServeContext, input: Record<string, unknown>) =>
    readWorldView(as, input);

  return {
    db,
    vaultPath,
    sourceKey,
    ctx,
    ref,
    write,
    async declare(kind, id, label) {
      return [
        await write({
          subject: id,
          predicate: "world.kind",
          object: { vocabulary: `world/${kind}` },
        }),
        await write({
          subject: id,
          predicate: `${kind}.label`,
          object: { literal: label },
        }),
      ];
    },
    materialize(subject) {
      const ids = bySubject.get(subject) ?? [];
      const claims = ids
        .map((id) => getClaim(db, id))
        .filter(
          (claim) => claim?.status === "live" && claim.receipt_id === null,
        );
      if (claims.length === 0)
        throw new Error(`no unwritten claims for ${subject}`);
      applyCanonWrite(
        { db, vault_path: vaultPath },
        claims as never,
        worldCanonTarget(db, claims[0]!.claim_id),
        {
          writer: "loop",
          budget: budget(),
        },
      );
    },
    find(as, kind, label) {
      const found = worldData(
        read(as, { operation: `find_${kind}s`, label, ...valid() }),
      );
      const match = (found["matches"] as { ref: WorldRef }[])[0];
      if (match === undefined) throw new Error(`no ${kind} labelled ${label}`);
      return match.ref;
    },
    card(as, kind, target) {
      return worldData(
        read(as, { operation: kind, [kind]: target, ...valid() }),
      );
    },
    read,
  };
}
