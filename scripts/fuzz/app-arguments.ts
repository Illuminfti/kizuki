import type { AppRoute } from "../../packages/cli/src/app/protocol";

export type Envelope = Record<string, unknown>;
export type Path = (string | number)[];

/** Fixture state a valid envelope refers to. */
export interface AppWorld {
  /** An enrolled, consentable source. */
  source: string;
  sourceRevision: number;
  modelRevision: string;
  /** A live claim that previews may name but no mutation applies. */
  claim: string;
  /** A fresh operation id for each envelope that needs one. */
  operation(): string;
}

// Well formed, but names nothing: enough to pass shape checks and be refused later.
const UNENROLLED = "00000000000000000000000000";
const WORLD_TOKEN = Buffer.alloc(32).toString("base64url");
const POLICY = { purposes: ["capture", "recall", "session"], allowed_fields: ["text", "subjects", "metadata", "attachments"],
  retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" };
const GRANT = { ceiling: "private", types: ["person"], subjects: ["person:synthetic"], since: "2026-01-01T00:00:00.000Z",
  until: "2026-12-31T00:00:00.000Z", tools: ["search", "world_view"], rate_limit_per_minute: 10, relay_owner_corrections: false };
const CURRENT = { knownAt: { kind: "current" } };

/**
 * One valid request per route and shape, every field a parser reads present,
 * so that mutating one field reaches that field's parser. A mutation must not
 * be able to do harm, so nothing here revokes the enrolled source, applies a
 * correction, selects a model endpoint that could be valid, or varies a path:
 * each accepted folder would persist a source and an initialization path could
 * create a vault.
 */
export function appEnvelopes(world: AppWorld): Record<AppRoute, Envelope[]> {
  const operation_id = () => world.operation();
  return {
    status: [], catalog: [], service_status: [], install_service: [], sources: [], model_status: [], run_pass: [], agents: [],
    initialize: [{ no_service: false }],
    enroll: [
      { provider: "gmail", fields: ["text", "subjects"], source_key: UNENROLLED, new_source: false },
      { provider: "google-calendar", fields: ["summary"], calendar_id: "synthetic-calendar" },
    ],
    consent: [{ source_key: world.source, expected_revision: world.sourceRevision, operation_id: operation_id(), policy: POLICY }],
    capture: [{ source_key: world.source, mode: "backfill" }],
    query: [{ text: "synthetic", limit: 5 }],
    activity: [{ limit: 5 }],
    undo: [{ receipt_id: "synthetic-receipt", cascade: false }],
    operation: [{ id: "synthetic-operation" }],
    revoke: [{ source_key: UNENROLLED, expected_revision: 0, operation_id: operation_id() }],
    resume_revocation: [{ source_key: UNENROLLED, operation_id: operation_id() }],
    model_save: [
      { expected_revision: world.modelRevision, selection: { kind: "none" }, credential: { action: "keep" } },
      // The endpoint is never valid, so no mutation selects a model to call.
      { expected_revision: world.modelRevision, selection: { kind: "openai_compatible", base_url: "not a url", model: "synthetic" }, credential: { action: "keep" } },
    ],
    model_test: [{ expected_revision: world.modelRevision }],
    source_model_consent: [{ source_key: world.source, expected_revision: world.sourceRevision, expected_model_revision: world.modelRevision, operation_id: operation_id(), allow: false }],
    agent_enroll: [{ name: "synthetic-client", operation_id: operation_id(), grant: GRANT }],
    agent_revoke: [{ name: "synthetic-absent" }],
    correction_targets: [{ page_id: "synthetic-page" }],
    correction_preview: [
      { claim_id: world.claim, statement: "Synthetic correction", object: "Synthetic object" },
      { target: { world_claim: { kind: "claim", token: WORLD_TOKEN } }, statement: "Synthetic correction" },
    ],
    // Parsed exactly as correction_preview is, but entered through a canon mutation scope that costs
    // far more per request. Its witness applies a live claim instead.
    correct: [],
    world_view: [
      { operation: "find_concepts", label: "synthetic", valid: { kind: "overlap", from: "2026-01-01T00:00:00.000Z", until: "2026-02-01T00:00:00.000Z" }, ...CURRENT },
      { operation: "find_situations", label: "synthetic", cursor: WORLD_TOKEN, valid: { kind: "at", at: "2026-01-15T12:00:00.000Z" }, ...CURRENT },
      { operation: "concept", concept: { kind: "object", token: WORLD_TOKEN }, valid: { kind: "all" }, knownAt: { kind: "snapshot", ref: { kind: "snapshot", token: WORLD_TOKEN } } },
    ],
  };
}

/** Every node of an envelope below its top level: each key, array element and nested value. */
function paths(value: unknown, at: Path = []): Path[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const path = [...at, Array.isArray(value) ? Number(key) : key];
    return [path, ...paths(item, path)];
  });
}

export function withValue(value: unknown, path: Path, replacement: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return replacement;
  if (Array.isArray(value)) return value.map((item, at) => at === head ? withValue(item, rest, replacement) : item);
  const record = value as Record<string, unknown>;
  return { ...record, [head]: withValue(record[String(head)], rest, replacement) };
}

/** The hostile text, and the other JSON types a field can be confused with; `undefined` drops the field. */
export function confuse(text: string, choice: number): unknown {
  const options: unknown[] = [text, null, undefined, [text], { text }, text.length, -text.length, true, false];
  return options[choice % options.length];
}

export interface AppSlot { route: AppRoute; base: number; path: Path }

/** Every field the campaign varies, in a fixed order. */
export function appSlots(): AppSlot[] {
  const probe = appEnvelopes({ source: UNENROLLED, sourceRevision: 0, modelRevision: "synthetic", claim: UNENROLLED, operation: () => "synthetic-operation" });
  return (Object.keys(probe) as AppRoute[]).flatMap(route => probe[route].flatMap((base, index) => paths(base).map(path => ({ route, base: index, path }))));
}

export interface AppWitness {
  route: AppRoute;
  /** A valid envelope, and the outcome that proves every parser on its way accepted it. */
  control: Envelope;
  accepted: string;
  /** One broken field at a time, and the refusal only that field's parser can give. */
  broken: { at: Path; value: unknown; refused: string }[];
}

/**
 * Proof that the campaign's envelopes reach the nested parsers: each control
 * gets past shape checks, enrollment or grant admission, consent policy,
 * model selection or correction parsing, and each broken copy is refused by
 * that parser rather than by anything earlier. Built when run, because every
 * success can change the revisions the next envelope must quote.
 */
export const APP_WITNESSES: readonly ((world: AppWorld & { applied: string }) => AppWitness)[] = [
  () => ({ route: "enroll", control: { provider: "gmail", fields: ["text"] }, accepted: "misconfigured",
    broken: [{ at: ["fields", 0], value: "{}", refused: "invalid_request" }] }),
  world => { const control = appEnvelopes(world).consent[0]!;
    return { route: "consent", control, accepted: "succeeded", broken: [{ at: ["policy", "allowed_fields", 0], value: "{}", refused: "invalid_request" }] }; },
  world => ({ route: "source_model_consent", control: appEnvelopes(world).source_model_consent[0]!, accepted: "succeeded",
    broken: [{ at: ["allow"], value: "{}", refused: "invalid_request" }] }),
  world => ({ route: "model_save", control: appEnvelopes(world).model_save[0]!, accepted: "succeeded",
    broken: [{ at: ["credential", "action"], value: "{}", refused: "credential_invalid" }] }),
  world => ({ route: "model_save", control: appEnvelopes(world).model_save[1]!, accepted: "configuration_invalid", broken: [] }),
  world => ({ route: "agent_enroll", control: appEnvelopes(world).agent_enroll[0]!, accepted: "succeeded",
    broken: [{ at: ["grant", "tools", 0], value: "{}", refused: "invalid_grant" }, { at: ["grant", "since"], value: "{}", refused: "invalid_grant" }] }),
  // A control character is refused by the app's own reader; 3,000 characters pass it and are refused by the serving parser.
  world => ({ route: "correction_preview", control: appEnvelopes(world).correction_preview[0]!, accepted: "succeeded",
    broken: [{ at: ["statement"], value: "\u0000", refused: "invalid_request" }, { at: ["statement"], value: "x".repeat(3000), refused: "invalid_request" }] }),
  world => ({ route: "correct", control: { claim_id: world.applied, statement: "Synthetic correction", object: "Synthetic object" }, accepted: "succeeded",
    broken: [{ at: ["statement"], value: "\u0000", refused: "invalid_request" }, { at: ["statement"], value: "x".repeat(3000), refused: "invalid_request" }] }),
  world => ({ route: "world_view", control: appEnvelopes(world).world_view[0]!, accepted: "succeeded",
    broken: [{ at: ["valid", "kind"], value: "{}", refused: "invalid_request" }] }),
];
