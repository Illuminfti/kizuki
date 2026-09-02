import { basename, extname } from "node:path";
import { stat } from "node:fs/promises";
import {
  HealthReport,
  KizukiError,
  computeContentHash,
  isPlainObject,
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
import {
  HASH_PREFIX_CHARS,
  decodeIcsCursor,
  emptyIcsCursor,
  encodeIcsCursor,
} from "./cursor";
import type { IcsCursor } from "./cursor";
import { calendarEvents } from "./events";
import { fetchIcs } from "./fetch";
import type { IcsFetcher } from "./fetch";
import { fixtureIcsEvents } from "./fixture";
import { ICS_CONNECTOR_ID, tombstone } from "./map";
import { parseIcs } from "./parse";
import { parseIcsState } from "./state";
import type { IcsState } from "./state";
import { signInIcs, urlLabel } from "./sign-in";

export { ICS_CONNECTOR_ID } from "./map";

export type IcsConnectorConfig =
  { path: string } | { secret_ref: string } | Record<string, never>;

export interface IcsConnectorDeps {
  fetch?: IcsFetcher;
  now?: () => Date;
}

const MANIFEST: Manifest = {
  schema: "kizuki.connector/v1",
  connector_id: ICS_CONNECTOR_ID,
  version: "0.1.0",
  kinds: ["calendar_event"],
  capabilities: {
    backfill: true,
    sync: true,
    tombstones: true,
    purge: false,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: true,
  auth_modes: ["none", "sign_in"],
};

const HEALTH_BY_CODE: Record<string, HealthState> = {
  unauthenticated: "unauthenticated",
  rate_limited: "rate_limited",
  unreachable: "unreachable",
  misconfigured: "misconfigured",
  missing_secret: "misconfigured",
  parse_error: "degraded",
  protocol: "degraded",
};

function configField(
  config: IcsConnectorConfig,
  field: "path" | "secret_ref",
): string | null {
  if (!isPlainObject(config)) return null;
  const value = (config as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface Snapshot {
  events: CaptureEventInput[];
  etag: string | null;
  lastModified: string | null;
  unchanged: boolean;
}

export class IcsConnector implements Connector {
  private readonly fetcher: IcsFetcher;
  private readonly now: () => Date;
  private readonly path: string | null;
  private readonly secretRef: string | null;
  private state: IcsState | null = null;
  private lastSuccessAt: string | undefined;
  /** Facts a run found that the next health report has to surface once. */
  private pendingNotes: string[] = [];

  constructor(config: IcsConnectorConfig, deps: IcsConnectorDeps = {}) {
    this.fetcher = deps.fetch ?? fetchIcs;
    this.now = deps.now ?? ((): Date => new Date());
    this.path = configField(config, "path");
    this.secretRef = configField(config, "secret_ref");
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  async connect(resolve: SecretResolver): Promise<void> {
    // File mode needs no credential; `health` still checks the path for real.
    if (this.path !== null) return;
    if (this.secretRef === null) {
      throw new KizukiError(
        "missing_secret",
        "kizuki.ics: not signed in; enroll this connection first",
      );
    }
    let text: string;
    try {
      text = await resolve(this.secretRef);
    } catch (error) {
      throw new KizukiError(
        "missing_secret",
        "kizuki.ics: connection state could not be resolved",
        { cause: error },
      );
    }
    const state = parseIcsState(text);
    // Validates for real: a URL that no longer parses as a calendar must not
    // read as connected.
    const response = await this.fetcher(state.url, {});
    parseIcs(response.text);
    this.state = state;
  }

  async health(): Promise<HealthReport> {
    const checkedAt = this.now().toISOString();
    if (this.path !== null) {
      try {
        const info = await stat(this.path);
        if (!info.isFile()) {
          return this.report("misconfigured", checkedAt, {
            detail: "path is not a file",
          });
        }
        return this.reportRun(checkedAt);
      } catch {
        return this.report("misconfigured", checkedAt, {
          detail: "calendar file cannot be read",
        });
      }
    }
    if (this.state === null) {
      return this.report("disabled", checkedAt, { detail: "not connected" });
    }
    try {
      const response = await this.fetcher(this.state.url, {});
      parseIcs(response.text);
      return this.reportRun(checkedAt);
    } catch (error) {
      // Only a typed message is safe to surface: an untyped failure carries
      // the request URL, and a private calendar URL is the credential.
      if (!(error instanceof KizukiError)) {
        return this.report("degraded", checkedAt, {
          detail: "calendar check failed",
        });
      }
      return this.report(HEALTH_BY_CODE[error.code] ?? "degraded", checkedAt, {
        detail: error.message,
      });
    }
  }

  /** A run that dropped entries must not read as healthy afterwards. */
  private noteSkipped(skipped: number): void {
    if (skipped === 0) return;
    this.pendingNotes.push(
      `${skipped} calendar ${skipped === 1 ? "entry" : "entries"} could not be read`,
    );
  }

  /** `ok`, unless the last run had something the owner needs to hear. */
  private reportRun(checkedAt: string): HealthReport {
    const notes = this.pendingNotes.splice(0);
    return notes.length > 0
      ? this.report("degraded", checkedAt, { detail: notes.join("; ") })
      : this.report("ok", checkedAt, {});
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

  private async snapshot(previous: IcsCursor): Promise<Snapshot> {
    const observedAt = this.now().toISOString();
    if (this.path !== null) {
      const file = Bun.file(this.path);
      let text: string;
      try {
        text = await file.text();
      } catch (error) {
        throw new KizukiError(
          "misconfigured",
          "kizuki.ics: calendar file cannot be read",
          { cause: error },
        );
      }
      const mapping = calendarEvents(parseIcs(text), {
        slugSource: basename(this.path, extname(this.path)),
        observedAt,
        now: this.now(),
      });
      this.noteSkipped(mapping.skipped);
      return {
        events: mapping.events,
        etag: null,
        lastModified: null,
        unchanged: false,
      };
    }
    if (this.state === null) {
      throw new KizukiError(
        "missing_secret",
        "kizuki.ics: not signed in; enroll this connection first",
      );
    }
    const response = await this.fetcher(this.state.url, {
      ...(previous.etag !== undefined ? { etag: previous.etag } : {}),
      ...(previous.last_modified !== undefined
        ? { last_modified: previous.last_modified }
        : {}),
    });
    if (response.status === 304) {
      return {
        events: [],
        etag: response.etag,
        lastModified: response.last_modified,
        unchanged: true,
      };
    }
    const mapping = calendarEvents(parseIcs(response.text), {
      slugSource: urlLabel(this.state.url),
      observedAt,
      now: this.now(),
    });
    this.noteSkipped(mapping.skipped);
    return {
      events: mapping.events,
      etag: response.etag,
      lastModified: response.last_modified,
      unchanged: false,
    };
  }

  private cursorFor(snapshot: Snapshot, previous: IcsCursor): IcsCursor {
    const records: Record<string, string> = snapshot.unchanged
      ? previous.records
      : Object.fromEntries(
          snapshot.events.map((event) => [
            event.source_record_id,
            computeContentHash(event).slice(0, HASH_PREFIX_CHARS),
          ]),
        );
    const etag = snapshot.etag ?? previous.etag;
    const lastModified = snapshot.lastModified ?? previous.last_modified;
    return {
      schema: "kizuki.ics-cursor/v1",
      records,
      ...(etag !== undefined && etag !== null ? { etag } : {}),
      ...(lastModified !== undefined && lastModified !== null
        ? { last_modified: lastModified }
        : {}),
    };
  }

  /** Re-emits the whole snapshot; the ledger's dedupe makes a replay a no-op. */
  async backfill(cursor: Cursor | null): Promise<SyncBatch> {
    const previous =
      cursor === null ? emptyIcsCursor() : decodeIcsCursor(cursor);
    // The cursor is ignored on purpose: a conditional GET could answer 304 and
    // hand back an empty batch, which is not what re-running a backfill means.
    const snapshot = await this.snapshot(emptyIcsCursor());
    this.lastSuccessAt = this.now().toISOString();
    return {
      events: snapshot.events,
      cursor: encodeIcsCursor(this.cursorFor(snapshot, previous)),
    };
  }

  async sync(cursor: Cursor | null): Promise<SyncBatch> {
    if (cursor === null) return this.backfill(null);
    const previous = decodeIcsCursor(cursor);
    const snapshot = await this.snapshot(previous);
    const next = this.cursorFor(snapshot, previous);
    this.lastSuccessAt = this.now().toISOString();
    if (snapshot.unchanged) {
      return { events: [], cursor: encodeIcsCursor(next) };
    }

    const observedAt = this.now().toISOString();
    const present = new Map(
      snapshot.events.map((event) => [event.source_record_id, event]),
    );
    const tombstones: CaptureEventInput[] = [];
    for (const id of Object.keys(previous.records)) {
      if (present.has(id)) continue;
      const [uid = id, recurrenceId] = id.split("#");
      tombstones.push(
        tombstone(
          id,
          {
            uid,
            ...(recurrenceId !== undefined
              ? { recurrence_id: recurrenceId }
              : {}),
          },
          observedAt,
        ),
      );
    }
    const changed = snapshot.events.filter(
      (event) =>
        previous.records[event.source_record_id] !==
        computeContentHash(event).slice(0, HASH_PREFIX_CHARS),
    );
    return {
      events: [...tombstones, ...changed],
      cursor: encodeIcsCursor(next),
    };
  }

  async revoke(): Promise<void> {
    this.state = null;
  }

  async signIn(
    io: SignInIo,
    writer: ConnectionStateWriter,
  ): Promise<SignInDisplay> {
    return signInIcs(io, writer, this.fetcher);
  }

  /** The calendar is the owner's file or feed; purge is ledger-side only. */
  async purgeSource(subject_id: string): Promise<PurgePlan> {
    return {
      subject_id,
      source_record_ids: [],
      unreachable_source_record_ids: [],
    };
  }

  async fixture(): Promise<CaptureEventInput[]> {
    return fixtureIcsEvents();
  }

}

export function createIcsConnector(
  config: IcsConnectorConfig,
  deps?: IcsConnectorDeps,
): IcsConnector {
  return new IcsConnector(config, deps);
}
