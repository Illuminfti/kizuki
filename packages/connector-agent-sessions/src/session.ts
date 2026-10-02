import { createHash } from "node:crypto";
import { EVENT_SCHEMA, isPlainObject } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import type { SessionFlavor, SessionsConnectorId } from "./config";
import { MAX_TEXT_BYTES, boundScan, redact, sanitize, truncateUtf8, wellFormed } from "./scrub";
import { dropScaffolding } from "./scaffolding";
import { boundScrubText } from "@kizuki/core/internal";

/** Marker of a context packet Kizuki itself served into a session. */
const SELF_CONTEXT_MARKER = "KIZUKI CONTEXT v1";
const OWN_TOOL_PREFIX = "mcp__kizuki__";
/** Text a harness injects around the person's words; never theirs. */
const HARNESS_TEXT = [
  "# AGENTS.md instructions",
];
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;
const MAX_TOOL_NAMES = 16;
const MAX_LABEL_CHARS = 256;
const MAX_LABEL_SCAN = 2048;

export interface SessionOptions {
  flavor: SessionFlavor;
  connectorId: SessionsConnectorId;
  /** Root-relative, forward slashes. */
  relpath: string;
  includeSubagents: boolean;
  excludeCwd: readonly string[];
  observedAt: string;
}

/** What a line became: an event, or a counted reason it did not. */
export type LineOutcome =
  { event: CaptureEventInput; redactions: number } | { skip: string };

interface Turn {
  role: "user" | "assistant";
  sessionId: string;
  /** The record's own id. */
  recordId: string;
  parentId: string | null;
  occurredAt: string;
  text: string;
  cwd: string | null;
  gitBranch: string | null;
  entrypoint: string | null;
  sidechain: boolean;
  toolNames: string[];
}

interface RawTurn {
  role: "user" | "assistant";
  sessionId: unknown;
  recordId: unknown;
  parentId?: unknown;
  timestamp: unknown;
  /** A string, or an array of content blocks. */
  content: unknown;
  /** Block types that carry the person's or the model's words. */
  textTypes: readonly string[];
  cwd: unknown;
  gitBranch: unknown;
  entrypoint?: unknown;
  sidechain?: boolean;
}

/** Interprets the lines of one transcript file in order. */
export class SessionReader {
  readonly #options: SessionOptions;
  #meta = {
    sessionId: null as string | null,
    cwd: null as string | null,
    gitBranch: null as string | null,
  };

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  /**
   * `emit` false reads a line for session context only, as a resumed Codex
   * file needs its first line. Null means the line held context, not a turn.
   */
  read(line: number, text: string, emit: boolean): LineOutcome | null {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { skip: "not_json" };
    }
    if (!isPlainObject(raw)) return { skip: "not_json" };
    const turn =
      this.#options.flavor === "claude-code"
        ? this.#claudeTurn(raw)
        : this.#codexTurn(raw, line);
    if (turn === null || !emit) return null;
    return "skip" in turn ? turn : this.#event(turn, line);
  }

  #claudeTurn(raw: Record<string, unknown>): Turn | { skip: string } {
    const type = raw["type"];
    if (type !== "user" && type !== "assistant")
      return { skip: "ignored_type" };
    if (raw["isMeta"] === true) return { skip: "meta" };
    if (raw["isCompactSummary"] === true) return { skip: "compact_summary" };
    const sidechain = raw["isSidechain"] === true;
    if (sidechain && !this.#options.includeSubagents)
      return { skip: "sidechain" };
    const message = raw["message"];
    if (!isPlainObject(message)) return { skip: "no_text" };
    return this.#finish({
      role: type,
      sessionId: raw["sessionId"],
      recordId: raw["uuid"],
      parentId: raw["parentUuid"],
      timestamp: raw["timestamp"],
      content: message["content"],
      textTypes: ["text"],
      cwd: raw["cwd"],
      gitBranch: raw["gitBranch"],
      entrypoint: raw["entrypoint"],
      sidechain,
    });
  }

  /** The first line names the session; response items carry the turns. */
  #codexTurn(
    raw: Record<string, unknown>,
    line: number,
  ): Turn | { skip: string } | null {
    const payload = raw["payload"];
    if (raw["type"] === "session_meta" && isPlainObject(payload)) {
      const git = payload["git"];
      this.#meta = {
        sessionId: str(payload["id"]),
        cwd: str(payload["cwd"]),
        gitBranch: isPlainObject(git) ? str(git["branch"]) : null,
      };
      return null;
    }
    if (
      raw["type"] !== "response_item" ||
      !isPlainObject(payload) ||
      payload["type"] !== "message"
    ) {
      return { skip: "ignored_type" };
    }
    const role = payload["role"];
    if (role !== "user" && role !== "assistant") return { skip: "other_role" };
    return this.#finish({
      role,
      sessionId:
        this.#meta.sessionId ??
        this.#options.relpath
          .split("/")
          .pop()!
          .replace(/\.jsonl$/, ""),
      recordId: `L${line}`,
      timestamp: raw["timestamp"],
      content: payload["content"],
      textTypes: ["input_text", "output_text"],
      cwd: this.#meta.cwd,
      gitBranch: this.#meta.gitBranch,
    });
  }

  /**
   * Only text blocks survive. Thinking, tool inputs and tool results are never
   * read: that is where file contents, environment dumps and web pages land.
   */
  #finish(raw: RawTurn): Turn | { skip: string } {
    const texts: string[] = [];
    const toolNames: string[] = [];
    const blocks =
      typeof raw.content === "string"
        ? [{ type: raw.textTypes[0], text: raw.content }]
        : raw.content;
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (!isPlainObject(block)) continue;
      const kind = block["type"];
      const text = block["text"];
      if (
        typeof kind === "string" &&
        raw.textTypes.includes(kind) &&
        typeof text === "string"
      ) {
        if (!HARNESS_TEXT.some((prefix) => text.trimStart().startsWith(prefix)))
          texts.push(text);
        continue;
      }
      const name = block["name"];
      if (
        kind === "tool_use" &&
        typeof name === "string" &&
        TOOL_NAME.test(name) &&
        !name.startsWith(OWN_TOOL_PREFIX) &&
        !toolNames.includes(name) &&
        toolNames.length < MAX_TOOL_NAMES
      )
        toolNames.push(name);
    }
    const text = texts.join("\n\n");
    if (text.trim() === "") return { skip: "no_text" };
    const cwd = str(raw.cwd);
    if (
      cwd !== null &&
      this.#options.excludeCwd.some(
        (prefix) => cwd === prefix || cwd.startsWith(`${prefix}/`),
      )
    ) {
      return { skip: "excluded_cwd" };
    }
    const sessionId = str(raw.sessionId);
    const recordId = str(raw.recordId);
    if (
      sessionId === null ||
      !IDENTIFIER.test(sessionId) ||
      recordId === null ||
      !IDENTIFIER.test(recordId)
    ) {
      return { skip: "bad_identity" };
    }
    const occurredAt = timestamp(raw.timestamp);
    if (occurredAt === null) return { skip: "bad_timestamp" };
    const parentId = str(raw.parentId);
    return {
      role: raw.role,
      sessionId,
      recordId,
      parentId:
        parentId !== null && IDENTIFIER.test(parentId) ? parentId : null,
      occurredAt,
      text,
      cwd,
      gitBranch: str(raw.gitBranch),
      entrypoint: str(raw.entrypoint),
      sidechain: raw.sidechain === true,
      toolNames,
    };
  }

  #event(turn: Turn, line: number): LineOutcome {
    const bounded = boundScan(turn.text);
    const sanitized = sanitize(bounded.text);
    const spoken = dropScaffolding(sanitized.text);
    // Filter feedback after removing harness blocks, preserving the person's
    // words around a hook-injected packet. Hidden characters are already gone.
    if (spoken.includes(SELF_CONTEXT_MARKER)) return { skip: "self_context" };
    const scrubbed = redact(spoken);
    if (scrubbed.text.trim() === "") return { skip: "no_text" };
    const cut = truncateUtf8(scrubbed.text, MAX_TEXT_BYTES);
    const redactions = Object.values(scrubbed.redactions).reduce(
      (total, n) => total + n,
      0,
    );
    const subjects: CaptureEventInput["subjects"] = [
      { subject_id: `session-role:${turn.role}`, role: "from" },
    ];
    const metadata: Record<string, unknown> = {
      session_id: turn.sessionId,
      is_sidechain: turn.sidechain,
      source_file: label(basename(this.#options.relpath), 256),
      line,
      tool_names: turn.toolNames,
    };
    if (this.#options.flavor === "claude-code") {
      metadata["uuid"] = turn.recordId;
      if (turn.parentId !== null) metadata["parent_uuid"] = turn.parentId;
    }
    if (turn.cwd !== null) {
      const project = label(basename(turn.cwd));
      subjects.push({
        subject_id: `project:${createHash("sha256").update(turn.cwd).digest("hex").slice(0, 12)}`,
        role: "about",
        display_name: project,
      });
      metadata["cwd_basename"] = project;
    }
    if (turn.gitBranch !== null) metadata["git_branch"] = label(turn.gitBranch);
    if (turn.entrypoint !== null)
      metadata["entrypoint"] = label(turn.entrypoint);
    if (redactions > 0) metadata["redactions"] = scrubbed.redactions;
    if (cut.truncated || bounded.truncated) metadata["text_truncated"] = true;
    if (sanitized.changed) metadata["text_sanitized"] = true;
    return {
      event: {
        schema: EVENT_SCHEMA,
        connector_id: this.#options.connectorId,
        source_record_id: `${turn.sessionId}/${turn.recordId}`,
        kind: "message",
        occurred_at: turn.occurredAt,
        observed_at: this.#options.observedAt,
        text: cut.text,
        subjects,
        deleted: false,
        attachments: [],
        metadata,
      },
      redactions,
    };
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function basename(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/** A short, inert label for display and metadata. */
function label(value: string, max = MAX_LABEL_CHARS): string {
  // Cut before scanning: labels come from the transcript and may be huge.
  return wellFormed(redact(sanitize(boundScrubText(value, MAX_LABEL_SCAN).text).text).text.slice(0, max));
}
