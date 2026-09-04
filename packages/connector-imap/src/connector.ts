import {
  HealthReport,
  KizukiError,
  freezeManifest,
  policyForConnector,
} from "@kizuki/core";
import type {
  CaptureEventInput,
  ConnectionStateWriter,
  Connector,
  Cursor,
  HealthState,
  Manifest,
  PurgePlan,
  SecretResolver,
  SignInDisplay,
  SignInIo,
  SyncBatch,
} from "@kizuki/core";
import { IMAP_CURSOR_SCHEMA } from "./cursor";
import { IMAP_CONNECTOR_ID, folderLabel, recordId } from "./events";
import { fixtureEvents } from "./fixture";
import { ImapSession } from "./imap/session";
import type { SessionOptions } from "./imap/session";
import { walkMailboxes } from "./mailbox";
import { parseImapState } from "./state";
import type { ImapState } from "./state";
import { dialTls } from "./transport";
import type { ImapDialer } from "./transport";
import { signInImap } from "./sign-in";

export { IMAP_CONNECTOR_ID } from "./events";

export const MAX_PURGE_IDS_PER_FOLDER = 10_000;

export interface ImapConnectorConfig {
  /** The host hands over `connection.secret_refs[0]` after enrollment. */
  secret_ref?: string;
}

export interface ImapConnectorDeps {
  dial?: ImapDialer;
  now?: () => Date;
  session?: SessionOptions;
}

const MANIFEST: Manifest = freezeManifest({
  schema: "kizuki.connector/v1",
  connector_id: IMAP_CONNECTOR_ID,
  version: "0.1.0",
  contract_minor: 1,
  implementation: "@kizuki/connector-imap",
  allowed_egress: [],
  cursor_schema: IMAP_CURSOR_SCHEMA,
  kinds: ["email"],
  capabilities: {
    backfill: true,
    sync: true,
    tombstones: true,
    purge: true,
    fixture: true,
  },
  // Empty because sign-in mints the state; `connect` still fails closed.
  required_secrets: [],
  emits_sensitivity_hint: true,
  ...policyForConnector(IMAP_CONNECTOR_ID),
  auth_modes: ["sign_in"],
});

const HEALTH_BY_CODE: Record<string, HealthState> = {
  unauthenticated: "unauthenticated",
  rate_limited: "rate_limited",
  unreachable: "unreachable",
  misconfigured: "misconfigured",
  missing_secret: "misconfigured",
  protocol: "degraded",
  parse_error: "degraded",
};

/**
 * Only a printable-ASCII address becomes a query. A subject id arrives from a
 * mail header or a third-party calendar, and a code point whose low byte is
 * CR, LF or SPACE would otherwise reach the wire as a second command line.
 */
function searchableAddress(subjectId: string): string | null {
  const address = subjectId.slice("email:".length);
  if (!/^[\x21-\x7e]+$/.test(address)) return null;
  return /["\\]/.test(address) ? null : address;
}

export class ImapConnector implements Connector {
  private readonly dial: ImapDialer;
  private readonly now: () => Date;
  private readonly sessionOptions: SessionOptions;
  private state: ImapState | null = null;
  private lastSuccessAt: string | undefined;
  /** Facts a run found that the next health report has to surface once. */
  private pendingNotes: string[] = [];

  constructor(
    private readonly config: ImapConnectorConfig,
    deps: ImapConnectorDeps = {},
  ) {
    this.dial = deps.dial ?? dialTls;
    this.now = deps.now ?? ((): Date => new Date());
    this.sessionOptions = deps.session ?? {};
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  async connect(resolve: SecretResolver): Promise<void> {
    const ref = this.config.secret_ref;
    if (typeof ref !== "string" || !ref.startsWith("file:")) {
      throw new KizukiError(
        "missing_secret",
        "kizuki.imap: not signed in; enroll this connection first",
      );
    }
    let text: string;
    try {
      text = await resolve(ref);
    } catch (error) {
      throw new KizukiError(
        "missing_secret",
        "kizuki.imap: connection state could not be resolved",
        { cause: error },
      );
    }
    const state = parseImapState(text);
    // Validates for real: a state file that no longer authenticates must not
    // read as connected.
    const session = await ImapSession.open(
      this.dial,
      state,
      this.sessionOptions,
    );
    await session.logout();
    this.state = state;
  }

  private requireState(): ImapState {
    if (this.state === null) {
      throw new KizukiError(
        "missing_secret",
        "kizuki.imap: not signed in; enroll this connection first",
      );
    }
    return this.state;
  }

  async health(): Promise<HealthReport> {
    const checkedAt = this.now().toISOString();
    if (this.state === null) {
      return new HealthReport({
        state: "disabled",
        checked_at: checkedAt,
        detail: "not connected",
        ...(this.lastSuccessAt !== undefined
          ? { last_success_at: this.lastSuccessAt }
          : {}),
      });
    }
    const state = this.state;
    try {
      const session = await ImapSession.open(
        this.dial,
        state,
        this.sessionOptions,
      );
      try {
        for (const wire of state.folders) {
          try {
            await session.examine(wire);
          } catch (error) {
            if (
              error instanceof KizukiError &&
              (error.code === "protocol" || error.code === "misconfigured")
            ) {
              return this.report("misconfigured", checkedAt, {
                detail: `folder not found: ${folderLabel(wire)}`,
              });
            }
            throw error;
          }
        }
      } finally {
        await session.logout();
      }
      const notes = this.pendingNotes.splice(0);
      return notes.length > 0
        ? this.report("degraded", checkedAt, { detail: notes.join("; ") })
        : this.report("ok", checkedAt, {});
    } catch (error) {
      // Only a typed message is safe to surface; anything else may quote the
      // command that failed, and a LOGIN line carries the app password.
      if (!(error instanceof KizukiError)) {
        return this.report("degraded", checkedAt, { detail: "check failed" });
      }
      return this.report(HEALTH_BY_CODE[error.code] ?? "degraded", checkedAt, {
        detail: error.message,
      });
    }
  }

  private report(
    state: HealthState,
    checkedAt: string,
    extra: { detail?: string },
  ): HealthReport {
    return new HealthReport({
      state,
      checked_at: checkedAt,
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      ...(this.lastSuccessAt !== undefined
        ? { last_success_at: this.lastSuccessAt }
        : {}),
    });
  }

  private async walk(
    cursor: Cursor | null,
    mode: "backfill" | "sync",
  ): Promise<SyncBatch> {
    const state = this.requireState();
    const result = await walkMailboxes(
      { dial: this.dial, state, now: this.now, session: this.sessionOptions },
      cursor,
      mode,
    );
    this.lastSuccessAt = this.now().toISOString();
    this.pendingNotes.push(...result.notes);
    return result.batch;
  }

  async backfill(cursor: Cursor | null): Promise<SyncBatch> {
    return this.walk(cursor, "backfill");
  }

  async sync(cursor: Cursor | null): Promise<SyncBatch> {
    return this.walk(cursor, "sync");
  }

  async revoke(): Promise<void> {
    // An app password is revoked at the provider by its owner; all this
    // connector holds is the copy in memory.
    this.state = null;
  }

  async signIn(
    io: SignInIo,
    writer: ConnectionStateWriter,
  ): Promise<SignInDisplay> {
    return signInImap(io, writer, {
      dial: this.dial,
      ...(Object.keys(this.sessionOptions).length > 0
        ? { session: this.sessionOptions }
        : {}),
    });
  }

  /**
   * Read-only at the source: the connector can list what a subject touched
   * but can never delete mail, so `source_record_ids` is always empty.
   */
  async purgeSource(subject_id: string): Promise<PurgePlan> {
    const empty: PurgePlan = {
      subject_id,
      source_record_ids: [],
      unreachable_source_record_ids: [],
    };
    if (this.state === null || !subject_id.startsWith("email:")) return empty;
    const address = searchableAddress(subject_id);
    if (address === null) return empty;

    const state = this.state;
    const unreachable: string[] = [];
    const session = await ImapSession.open(
      this.dial,
      state,
      this.sessionOptions,
    );
    try {
      for (const wire of state.folders) {
        const status = await session.examine(wire);
        const quoted = `"${address}"`;
        const found = await session.search(
          `OR OR FROM ${quoted} TO ${quoted} CC ${quoted}`,
        );
        for (const uid of found.slice(0, MAX_PURGE_IDS_PER_FOLDER)) {
          unreachable.push(recordId(wire, status.uidvalidity, uid));
        }
      }
      await session.logout();
    } catch (error) {
      session.close();
      throw error;
    }
    return {
      subject_id,
      source_record_ids: [],
      unreachable_source_record_ids: unreachable,
    };
  }

  async fixture(): Promise<CaptureEventInput[]> {
    return fixtureEvents();
  }
}

export function createImapConnector(
  config: ImapConnectorConfig,
  deps?: ImapConnectorDeps,
): ImapConnector {
  return new ImapConnector(config, deps);
}
