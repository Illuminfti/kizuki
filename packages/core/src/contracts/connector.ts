import type { CaptureEventInput, SensitivityHint } from "./event";
import { isRfc3339 } from "../util/time";

export const CONNECTOR_SCHEMA = "kizuki.connector/v1" as const;

/** Opaque resume tokens larger than this are refused before any persist. */
export const MAX_CURSOR_BYTES = 8 * 1024;
/** One SyncBatch may not materialize more events than this. */
export const MAX_SYNC_BATCH_EVENTS = 1_000;
/** Serialized event payload ceiling for one SyncBatch. */
export const MAX_SYNC_BATCH_BYTES = 4 * 1024 * 1024;
/** Host-side bound for backfill/sync/health/revoke. */
export const CONNECTOR_OPERATION_DEADLINE_MS = 60_000;
/** Host-side bound for interactive sign-in, including a browser hop. */
export const CONNECTOR_SIGN_IN_DEADLINE_MS = 300_000;

export const HEALTH_STATES = [
  "ok",
  "degraded",
  "unauthenticated",
  "rate_limited",
  "unreachable",
  "misconfigured",
  "disabled",
] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export function isHealthState(v: unknown): v is HealthState {
  return (
    typeof v === "string" && (HEALTH_STATES as readonly string[]).includes(v)
  );
}

/**
 * Opaque resume token. The spine persists it verbatim as a checkpoint and
 * never parses it; only the connector that minted it may interpret it.
 */
export type Cursor = string;

/**
 * How a person connects a source. `sign_in` and `oauth` mean the owner runs
 * `kizuki connect <id>` and signs in interactively — no developer console,
 * no keys to paste; the connector persists what it needs under secret_refs.
 */
export const AUTH_MODES = ["none", "sign_in", "oauth", "secret_ref"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export function isAuthMode(v: unknown): v is AuthMode {
  return typeof v === "string" && (AUTH_MODES as readonly string[]).includes(v);
}

export interface ManifestCapabilities {
  backfill: boolean;
  sync: boolean;
  tombstones: boolean;
  purge: boolean;
  fixture: boolean;
  /**
   * Whether the host may stage a typed page from this source's event metadata
   * rather than a quoted capture note. Metadata is attacker-controlled input
   * (AGENTS.md invariant 7), so the grant is bound to the connector rather
   * than carried in the metadata that asks for it, and its absence denies.
   */
  page_candidates?: boolean;
}

export interface Manifest {
  schema: typeof CONNECTOR_SCHEMA;
  connector_id: string;
  version: string;
  kinds: string[]; // event kinds this connector may emit
  capabilities: ManifestCapabilities;
  /** `secret_ref` URIs the connector needs (`env:`, `file:`); never plaintext. */
  required_secrets: string[];
  emits_sensitivity_hint: boolean;
  /**
   * What a record from this source is labeled when the source says nothing.
   * Sensitivity is assigned from the connector, never asked of the owner.
   */
  default_sensitivity?: SensitivityHint;
  /**
   * The least sensitive label a record from this source may carry. A
   * `sensitivity_hint` is honored only upward from here: a source that claims
   * less than its floor is raised to it rather than believed.
   */
  sensitivity_floor?: SensitivityHint;
  /** Non-empty; `sign_in`/`oauth` require a `signIn` implementation. */
  auth_modes: AuthMode[];
  /** Additive `kizuki.connector/v1` minor; host binds on major match. */
  contract_minor?: number;
  /** Workspace or npm package that ships this implementation. */
  implementation?: string;
  /**
   * Hosts this connector may contact. Empty means no network. A host that is
   * chosen at enrollment (IMAP, ICS URL) is not listed here.
   */
  allowed_egress?: readonly string[];
  /** Cursor JSON schema id, or `null` when the source is a single-shot export. */
  cursor_schema?: string | null;
}

/**
 * Deep-freeze a manifest so capabilities, kinds, secrets and auth modes
 * cannot change after the connector handed them to a host.
 */
export function freezeManifest(manifest: Manifest): Manifest {
  const kinds = [...manifest.kinds];
  const required_secrets = [...manifest.required_secrets];
  const auth_modes = [...manifest.auth_modes];
  const capabilities = { ...manifest.capabilities };
  const allowed_egress =
    manifest.allowed_egress === undefined
      ? undefined
      : [...manifest.allowed_egress];
  const frozen: Manifest = {
    ...manifest,
    kinds,
    capabilities,
    required_secrets,
    auth_modes,
  };
  if (allowed_egress !== undefined) {
    frozen.allowed_egress = allowed_egress;
  }
  Object.freeze(kinds);
  Object.freeze(required_secrets);
  Object.freeze(auth_modes);
  Object.freeze(capabilities);
  if (allowed_egress !== undefined) {
    Object.freeze(allowed_egress);
  }
  Object.freeze(frozen);
  return frozen;
}

/** Terminal-facing prompts the CLI lends a connector during `signIn`. */
export interface SignInIo {
  prompt(question: string, opts?: { secret?: boolean }): Promise<string>;
  notify(text: string): void;
  /** Opens the owner's browser; resolves once the URL was handed off. */
  openUrl(url: string): Promise<void>;
}

export interface SignInDisplay {
  /** Ephemeral terminal label; hosts must not persist connector-authored text. */
  display: string;
}

/** A capability scoped to one enrollment, supplied by the trusted host. */
export interface ConnectionStateWriter {
  write(state: Uint8Array): Promise<void>;
}

export interface HealthReportInit {
  state: HealthState;
  checked_at: string; // RFC3339
  detail?: string | undefined;
  last_success_at?: string | undefined; // RFC3339
}

/**
 * Validated at construction: an unknown state or a malformed timestamp throws
 * rather than producing a report that `kizuki doctor` would render as healthy.
 */
export class HealthReport {
  readonly state: HealthState;
  readonly checked_at: string;
  readonly detail: string | undefined;
  readonly last_success_at: string | undefined;

  constructor(init: HealthReportInit) {
    if (!isHealthState(init.state)) {
      throw new TypeError(
        `HealthReport: state must be one of ${HEALTH_STATES.join(" | ")}, got ${JSON.stringify(init.state)}`,
      );
    }
    if (!isRfc3339(init.checked_at)) {
      throw new TypeError(
        "HealthReport: checked_at must be an RFC3339 timestamp",
      );
    }
    if (
      init.last_success_at !== undefined &&
      !isRfc3339(init.last_success_at)
    ) {
      throw new TypeError(
        "HealthReport: last_success_at must be an RFC3339 timestamp",
      );
    }
    if (init.detail !== undefined && typeof init.detail !== "string") {
      throw new TypeError("HealthReport: detail must be a string when present");
    }
    this.state = init.state;
    this.checked_at = init.checked_at;
    this.detail = init.detail;
    this.last_success_at = init.last_success_at;
  }
}

/** Resolves a `secret_ref` URI to plaintext at call time; core never stores the value. */
export type SecretResolver = (secret_ref: string) => Promise<string>;

export type SyncBatchStatus = "ok" | "unavailable";

export interface SyncBatch {
  events: CaptureEventInput[];
  /** Checkpoint to resume from; `null` once the source is exhausted. */
  cursor: Cursor | null;
  /**
   * Absent means ok. `unavailable` is not an empty page: the host must not
   * advance the checkpoint (RFC 0002 E11 / tri-state).
   */
  status?: SyncBatchStatus;
  detail?: string;
}

export interface PurgePlan {
  subject_id: string;
  source_record_ids: string[];
  /** Records the connector can see but cannot remove at the source. */
  unreachable_source_record_ids: string[];
  /** Absent on legacy plans, which are unknown rather than complete. */
  complete?: boolean;
  /** Opaque connector-bound continuation for an incomplete plan page. */
  continuation?: string;
}

export interface Connector {
  manifest(): Manifest;
  health(): Promise<HealthReport>;
  connect(resolve: SecretResolver): Promise<void>;
  /** Historical sweep. Idempotent: replaying the same cursor yields the same events. */
  backfill(cursor: Cursor | null): Promise<SyncBatch>;
  /** Incremental sweep from a checkpoint; emits tombstones as `deleted: true` events. */
  sync(cursor: Cursor | null): Promise<SyncBatch>;
  revoke(): Promise<void>;
  /**
   * Interactive first-time sign-in (phone code, browser OAuth, app
   * password). The trusted host lends a scoped opaque-state writer and owns
   * both the filename and persisted connection record. Required when
   * `auth_modes` includes `sign_in` or `oauth`.
   */
  signIn?(io: SignInIo, state: ConnectionStateWriter): Promise<SignInDisplay>;
  purgeSource(subject_id: string): Promise<PurgePlan>;
  /** Offline sample used by the conformance suite; must need no credentials. */
  fixture(): Promise<CaptureEventInput[]>;
}
