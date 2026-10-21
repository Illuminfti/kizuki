import { createHash } from "node:crypto";
import {
  HealthReport,
  KizukiError,
  freezeManifest,
  policyForConnector,
} from "@kizuki/core";
import type {
  CaptureEventInput,
  Connector,
  Cursor,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
  RunContext,
} from "@kizuki/core";
import {
  CLAUDE_CODE_SESSIONS_CONNECTOR_ID,
  CODEX_SESSIONS_CONNECTOR_ID,
  parseConfig,
} from "./config";
import type {
  AgentSessionsConfig,
  ParsedAgentSessionsConfig,
  SessionFlavor,
  SessionsConnectorId,
} from "./config";
import {
  AGENT_SESSIONS_CURSOR_SCHEMA,
  encodeCursor,
  initialCursor,
  parseCursor,
} from "./cursor";
import type { SessionPosition } from "./cursor";
import {
  count,
  MAX_LINE_BYTES,
  listSessionFiles,
  openSessionFile,
  readLines,
  resolveRoot,
} from "./files";
import type { Counters, SessionFile } from "./files";
import { FIXTURE_FILES, FIXTURE_NOW } from "./fixture";
import { SessionReader } from "./session";
import { boundOffsets, encodeOffset, fileKey, matchesOffset, offsetDigest, parseOffset } from "./offsets";

/** Files touched this long before the watermark are read again, for clock and mtime slop. */
export const OVERLAP_MS = 120_000;
export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_BYTES = 2 * 1024 * 1024;
/** File bytes decoded per call, so one call stays well inside the host deadline. */
export const MAX_SCAN_BYTES = 64 * 1024 * 1024;
/** Serialized overhead assumed per event on top of its text. */
const EVENT_OVERHEAD_BYTES = 2048;

const FLAVOR: Readonly<Record<SessionsConnectorId, SessionFlavor>> = {
  [CLAUDE_CODE_SESSIONS_CONNECTOR_ID]: "claude-code",
  [CODEX_SESSIONS_CONNECTOR_ID]: "codex",
};

export interface AgentSessionsDeps {
  now: () => number;
  /** Descriptor reads can be counted without weakening the production open policy. */
  openFile: typeof openSessionFile;
}

interface Visit {
  file: SessionFile;
  /** The mtime this file sorts by, which a resumed file keeps from its cursor. */
  orderMtime: number;
  skipLines: number;
}

export class AgentSessionsConnector implements Connector {
  readonly #id: SessionsConnectorId;
  readonly #flavor: SessionFlavor;
  readonly #config: ParsedAgentSessionsConfig;
  readonly #now: () => number;
  readonly #openFile: typeof openSessionFile;
  readonly #manifest: Manifest;
  /** Counts since construction; `health()` reports them and no run state depends on them. */
  readonly #report: Counters = {};
  #revoked = false;

  constructor(
    id: SessionsConnectorId,
    config: AgentSessionsConfig,
    deps: Partial<AgentSessionsDeps> = {},
  ) {
    this.#id = id;
    this.#flavor = FLAVOR[id];
    this.#config = parseConfig(id, config);
    this.#now = deps.now ?? Date.now;
    this.#openFile = deps.openFile ?? openSessionFile;
    this.#manifest = freezeManifest({
      schema: "kizuki.connector/v1",
      connector_id: id,
      version: "0.1.0",
      contract_minor: 1,
      implementation: "@kizuki/connector-agent-sessions",
      allowed_egress: [],
      cursor_schema: AGENT_SESSIONS_CURSOR_SCHEMA,
      kinds: ["message"],
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: false,
        purge: false,
        fixture: true,
        cursor_store: "host",
        sync_from_backfill_before_first_success: true,
      },
      required_secrets: [],
      emits_sensitivity_hint: false,
      ...policyForConnector(id),
      auth_modes: ["none"],
    });
  }

  manifest(): Manifest {
    return this.#manifest;
  }

  /**
   * Degraded while the tree holds files this connector refuses to read, such
   * as links, pipes or oversized files. The detail also reports what this
   * instance has read and dropped so far.
   */
  async health(): Promise<HealthReport> {
    const checked_at = new Date(this.#now()).toISOString();
    if (this.#revoked) return new HealthReport({ state: "disabled", checked_at, detail: "revoked" });
    const root = await resolveRoot(this.#config.path);
    if (root === null) {
      return new HealthReport({ state: "misconfigured", checked_at, detail: "source directory is not readable" });
    }
    const { skipped } = await listSessionFiles(root, this.#config.include_subagents);
    const detail = Object.entries({ ...this.#report, ...skipped })
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    return new HealthReport({
      state: Object.keys(skipped).length > 0 ? "degraded" : "ok",
      checked_at,
      ...(detail === "" ? {} : { detail: detail.slice(0, 256) }),
    });
  }

  async connect(_resolve: SecretResolver): Promise<void> {
    this.#assertActive();
    if ((await resolveRoot(this.#config.path)) === null) {
      throw new KizukiError(
        "misconfigured",
        `${this.#id}: source is not a readable directory`,
      );
    }
  }

  backfill(cursor: Cursor | null, context?: RunContext): Promise<SyncBatch> {
    return this.#pass(cursor, context);
  }

  sync(cursor: Cursor | null, context?: RunContext): Promise<SyncBatch> {
    return this.#pass(cursor, context);
  }

  async revoke(): Promise<void> {
    this.#revoked = true;
  }

  async purgeSource(_subjectId: string): Promise<PurgePlan> {
    throw new KizukiError(
      "not_supported",
      `${this.#id}: transcripts are never deleted at the source; use ledger purge for captured evidence`,
    );
  }

  async fixture(): Promise<CaptureEventInput[]> {
    const events: CaptureEventInput[] = [];
    for (const [relpath, lines] of Object.entries(
      FIXTURE_FILES[this.#flavor],
    )) {
      const reader = this.#reader(relpath, new Date(FIXTURE_NOW).toISOString());
      lines.forEach((line, index) => {
        const outcome = reader.read(index + 1, line, true);
        if (outcome !== null && "event" in outcome) events.push(outcome.event);
      });
    }
    return events;
  }

  /**
   * One pass over every file touched since the watermark, in (mtime, relpath)
   * order. Backfill and sync are the same walk: a new source starts at
   * watermark zero, and a finished pass leaves the watermark at the newest
   * mtime it saw.
   */
  async #pass(cursor: Cursor | null, context?: RunContext): Promise<SyncBatch> {
    this.#assertActive();
    const root = await resolveRoot(this.#config.path);
    if (root === null)
      throw new KizukiError(
        "unavailable",
        `${this.#id}: source directory is not readable`,
      );
    const rootSha256 = createHash("sha256").update(root).digest("hex");
    const state =
      cursor === null ? initialCursor(rootSha256) : parseCursor(cursor);
    if (state.root_sha256 !== rootSha256) {
      throw new KizukiError(
        "misconfigured",
        `${this.#id}: cursor belongs to a different source directory`,
      );
    }

    const listing = await listSessionFiles(
      root,
      this.#config.include_subagents,
    );
    const floor =
      state.watermark_ms === 0 ? -1 : state.watermark_ms - OVERLAP_MS;
    const visits = plan(listing.files, floor, state.after);
    // A null cursor is an explicit replay. Never use offsets from a different pass.
    const committed = context?.cursor_store ?? new Map<string, string>();
    const offsets = new Map(cursor === null ? [] : committed);
    const finishStore = (watermark: number, keep: string | null): Pick<SyncBatch, "cursor_store"> => {
      if (context === undefined) return {};
      boundOffsets(offsets, listing.files.filter((file) => file.mtime_ms > watermark - OVERLAP_MS), keep);
      const delta: Record<string, string | null> = {};
      for (const key of committed.keys()) if (!offsets.has(key)) delta[key] = null;
      for (const [key, value] of offsets) if (committed.get(key) !== value) delta[key] = value;
      state.store_sha256 = offsetDigest(offsets);
      return { cursor_store: delta };
    };

    const events: CaptureEventInput[] = [];
    const observedAt = new Date(this.#now()).toISOString();
    let eventBytes = 0;
    let scanned = 0;
    let position: SessionPosition | null = state.after;
    let newest = state.after?.mtime_ms ?? 0;
    const full = (): boolean =>
      events.length >= MAX_BATCH_EVENTS ||
      eventBytes >= MAX_BATCH_BYTES ||
      scanned >= MAX_SCAN_BYTES;

    for (const visit of visits) {
      if (full()) break;
      const { file, orderMtime } = visit;
      let skipLines = visit.skipLines;
      newest = Math.max(newest, file.mtime_ms);
      position = {
        mtime_ms: orderMtime,
        relpath: file.relpath,
        line: skipLines,
      };
      const opened = await this.#openFile(file.absolute);
      if ("reason" in opened) {
        count(this.#report, opened.reason);
        continue;
      }
      count(this.#report, "files");
      try {
        const info = await opened.handle.stat();
        const key = fileKey(file.relpath);
        const saved = parseOffset(offsets.get(key));
        let offset = 0;
        let line = 0;
        let headless = false;
        if (saved !== null) {
          if (await matchesOffset(opened.handle, info, saved)) {
            offset = saved[3];
            line = saved[4];
            skipLines = line;
            headless = saved[7];
          } else {
            // Rewrites, truncations and replacements must also restart a paused page.
            skipLines = 0;
          }
        }
        if (saved === null && context !== undefined) skipLines = 0;
        const reader = this.#reader(file.relpath, observedAt, headless);
        if (offset > 0 && this.#flavor === "codex") {
          // Codex names its session on line one. Read that bounded line for context,
          // then seek directly to the first byte the host has not committed.
          for await (const first of readLines(opened.handle, 0, 0, 0, Math.min(info.size, MAX_LINE_BYTES + 1), 4096)) {
            if (first.text !== null) reader.read(first.line, first.text, false);
            break;
          }
        }
        for await (const entry of readLines(opened.handle, context === undefined && !this.#config.include_headless ? 0 : skipLines, offset, line, info.size)) {
          const emit = entry.line > skipLines;
          if (entry.text === null) {
            if (emit) count(this.#report, "oversized_line");
          } else {
            const outcome = reader.read(entry.line, entry.text, emit);
            if (outcome !== null && "skip" in outcome)
              count(this.#report, outcome.skip);
            else if (outcome !== null) {
              events.push(outcome.event);
              eventBytes +=
                Buffer.byteLength(outcome.event.text) + EVENT_OVERHEAD_BYTES;
              count(this.#report, "events");
              if (outcome.redactions > 0) count(this.#report, "redactions", outcome.redactions);
            }
          }
          offset = entry.offset;
          line = entry.line;
          if (!emit) continue;
          position = {
            mtime_ms: orderMtime,
            relpath: file.relpath,
            line: entry.line,
          };
          scanned += entry.bytes;
          if (full()) break;
        }
        if (context !== undefined) offsets.set(key, await encodeOffset(opened.handle, info, offset, line, reader.headless));
      } finally {
        await opened.handle.close();
      }
    }

    if (full() && position !== null) {
      const store = finishStore(state.watermark_ms, fileKey(position.relpath));
      return {
        events,
        ...store,
        cursor: encodeCursor({ ...state, after: position, exhausted: false }),
        has_more: true,
      };
    }
    // Clamped to now: a file dated in the future must not park the watermark
    // beyond every real write.
    const watermark_ms = Math.max(
      state.watermark_ms,
      Math.min(newest, this.#now()),
    );
    const store = finishStore(watermark_ms, null);
    return {
      events,
      ...store,
      cursor: encodeCursor({
        ...state,
        watermark_ms,
        after: null,
        exhausted: true,
      }),
      has_more: false,
    };
  }

  #reader(relpath: string, observedAt: string, initialHeadless = false): SessionReader {
    return new SessionReader({
      flavor: this.#flavor,
      connectorId: this.#id,
      relpath,
      includeSubagents: this.#config.include_subagents,
      includeHeadless: this.#config.include_headless,
      initialHeadless,
      excludeCwd: this.#config.exclude_cwd,
      observedAt,
    });
  }

  #assertActive(): void {
    if (this.#revoked)
      throw new KizukiError(
        "unavailable",
        `${this.#id}: connector was revoked`,
      );
  }
}

/**
 * The file the cursor stopped inside resumes first, at its line, whatever its
 * mtime has become since: these transcripts only grow. Everything else is what
 * sorts after the cursor position.
 */
function plan(
  files: readonly SessionFile[],
  floor: number,
  after: SessionPosition | null,
): Visit[] {
  const touched = files.filter((file) => file.mtime_ms > floor);
  if (after === null)
    return touched.map((file) => ({
      file,
      orderMtime: file.mtime_ms,
      skipLines: 0,
    }));
  const resumed = touched.find((file) => file.relpath === after.relpath);
  const rest = touched.filter(
    (file) =>
      file.relpath !== after.relpath &&
      (file.mtime_ms > after.mtime_ms ||
        (file.mtime_ms === after.mtime_ms && file.relpath > after.relpath)),
  );
  return [
    ...(resumed === undefined
      ? []
      : [{ file: resumed, orderMtime: after.mtime_ms, skipLines: after.line }]),
    ...rest.map((file) => ({ file, orderMtime: file.mtime_ms, skipLines: 0 })),
  ];
}

export function createClaudeCodeSessionsConnector(
  config: AgentSessionsConfig,
  deps?: Partial<AgentSessionsDeps>,
): AgentSessionsConnector {
  return new AgentSessionsConnector(
    CLAUDE_CODE_SESSIONS_CONNECTOR_ID,
    config,
    deps,
  );
}

export function createCodexSessionsConnector(
  config: AgentSessionsConfig,
  deps?: Partial<AgentSessionsDeps>,
): AgentSessionsConnector {
  return new AgentSessionsConnector(CODEX_SESSIONS_CONNECTOR_ID, config, deps);
}
