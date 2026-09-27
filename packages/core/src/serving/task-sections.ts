import { timingSafeEqual } from "node:crypto";
import { sha256 } from "../agents/hash";
import type { AuditDenial } from "../agents";
import { identifier } from "./arguments";
import { eventDecision, currentQuotedSource } from "./ledger";
import { packetTokens } from "./packet-tokenizer";
import { ServeError } from "./types";
import type { QuotedChunk, ServeContext } from "./types";

/** Captured task records use this first line. It is data, not a packet rule. */
export const TASK_MARKER = "kizuki.task/v1";

const TASK_KINDS = [
  "constraint",
  "objective",
  "decision",
  "rejected",
  "question",
  "coverage",
  "hint",
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

const MAX_LINES = 24;
const MAX_PER_KIND = 8;
const MAX_TEXT = 200;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export interface TaskAttachment {
  status: "current" | "incomplete" | "unavailable";
  reason?:
    | "constraints_do_not_fit"
    | "constraints_absent"
    | "budget"
    | "bounds"
    | "unparsed"
    | "denied";
  /** SHA-256 of the current capture. Absent when the text is withheld. */
  integrity?: string;
  sections?: Record<TaskKind, string[]>;
  omitted?: TaskKind[];
}

export interface TaskRead {
  task: TaskAttachment;
  /** Markdown to append. Empty when no captured line is served. */
  block: string;
  quoted: QuotedChunk[];
  withheld: AuditDenial[];
}

interface TaskArgs {
  event_id: string;
  integrity?: string;
}

function refuse(field: string, rule: string): ServeError {
  return new ServeError("invalid_arguments", `invalid arguments: ${field}: ${rule}`);
}

function digestOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw refuse("task_integrity", "must be a sha256 hex digest");
  }
  return value;
}

function sameDigest(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function parseTaskArgs(args: {
  task_event_id?: string;
  task_integrity?: string;
}): TaskArgs | undefined {
  if (args.task_event_id === undefined && args.task_integrity === undefined) return undefined;
  if (args.task_event_id === undefined) {
    throw refuse("task_event_id", "required to read task sections");
  }
  const integrity = digestOf(args.task_integrity);
  return {
    event_id: identifier("task_event_id", args.task_event_id),
    ...(integrity === undefined ? {} : { integrity }),
  };
}

function blankSections(): Record<TaskKind, string[]> {
  return {
    constraint: [],
    objective: [],
    decision: [],
    rejected: [],
    question: [],
    coverage: [],
    hint: [],
  };
}

function isKind(value: string): value is TaskKind {
  return (TASK_KINDS as readonly string[]).includes(value);
}

function parseRecord(
  text: string,
): { ok: true; sections: Record<TaskKind, string[]> } | { ok: false; reason: "unparsed" | "bounds" } {
  if (FORBIDDEN.test(text)) return { ok: false, reason: "unparsed" };
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines[0] !== TASK_MARKER) return { ok: false, reason: "unparsed" };
  const body = lines.slice(1);
  if (body.length === 0 || body.length > MAX_LINES) {
    return { ok: false, reason: body.length === 0 ? "unparsed" : "bounds" };
  }
  const sections = blankSections();
  for (const line of body) {
    const split = line.indexOf(": ");
    if (split < 1) return { ok: false, reason: "unparsed" };
    const kind = line.slice(0, split);
    const value = line.slice(split + 2);
    if (!isKind(kind)) return { ok: false, reason: "unparsed" };
    if (value.length === 0 || Array.from(value).length > MAX_TEXT) {
      return { ok: false, reason: "bounds" };
    }
    const bucket = sections[kind];
    if (bucket.length >= MAX_PER_KIND) return { ok: false, reason: "bounds" };
    bucket.push(value);
  }
  return { ok: true, sections };
}

function line(kind: TaskKind, value: string): string {
  return `${kind}: ${value}`;
}

function header(eventId: string, integrity: string): string {
  return `## task\ncaptured=${TASK_MARKER} event=${eventId} integrity=${integrity}\n`;
}

function pack(
  eventId: string,
  integrity: string,
  sections: Record<TaskKind, string[]>,
  soFar: string,
  budget: number,
): { block: string; included: TaskKind[]; omitted: TaskKind[]; status: TaskAttachment["status"]; reason?: TaskAttachment["reason"] } {
  const fits = (block: string) => packetTokens(`${soFar}${block}`) <= budget;
  const recorded = TASK_KINDS.filter((kind) => sections[kind].length > 0);
  const lead = header(eventId, integrity);

  if (sections.constraint.length === 0) {
    if (!fits(lead)) {
      return { block: "", included: [], omitted: recorded, status: "incomplete", reason: "constraints_absent" };
    }
    let block = lead;
    const included: TaskKind[] = [];
    const omitted: TaskKind[] = [];
    let stopped = false;
    for (const kind of TASK_KINDS) {
      if (kind === "constraint" || sections[kind].length === 0) continue;
      if (stopped) {
        omitted.push(kind);
        continue;
      }
      const next = `${block}${sections[kind].map((value) => line(kind, value)).join("\n")}\n`;
      if (!fits(next)) {
        stopped = true;
        omitted.push(kind);
        continue;
      }
      block = next;
      included.push(kind);
    }
    return { block: included.length === 0 ? "" : block, included, omitted, status: "incomplete", reason: "constraints_absent" };
  }

  const constraints = `${lead}${sections.constraint.map((value) => line("constraint", value)).join("\n")}\n`;
  if (!fits(constraints)) {
    return {
      block: "",
      included: [],
      omitted: recorded,
      status: "incomplete",
      reason: "constraints_do_not_fit",
    };
  }
  let block = constraints;
  const included: TaskKind[] = ["constraint"];
  const omitted: TaskKind[] = [];
  let stopped = false;
  for (const kind of TASK_KINDS) {
    if (kind === "constraint" || sections[kind].length === 0) continue;
    if (stopped) {
      omitted.push(kind);
      continue;
    }
    const next = `${block}${sections[kind].map((value) => line(kind, value)).join("\n")}\n`;
    if (!fits(next)) {
      stopped = true;
      omitted.push(kind);
      continue;
    }
    block = next;
    included.push(kind);
  }
  return {
    block,
    included,
    omitted,
    status: omitted.length === 0 ? "current" : "incomplete",
    ...(omitted.length === 0 ? {} : { reason: "budget" as const }),
  };
}

function servedSections(
  sections: Record<TaskKind, string[]>,
  included: TaskKind[],
): Record<TaskKind, string[]> {
  const out = blankSections();
  for (const kind of included) out[kind] = sections[kind];
  return out;
}

/**
 * Read one permitted capture as structured task sections. A vault path is an
 * event id lookup, never a file read. A hint line is a relevance label from
 * that capture, not a grant and not a file read. Constraints are kept whole
 * or withheld.
 */
export function readTaskAttachment(
  ctx: ServeContext,
  args: TaskArgs,
  soFar: string,
  budget: number,
): TaskRead {
  const source = currentQuotedSource(ctx.db, args.event_id);
  if (source === null) return { task: { status: "unavailable" }, block: "", quoted: [], withheld: [] };
  const decision = eventDecision(ctx.principal.grant, source, ctx);
  if (!decision.allow) {
    return {
      task: { status: "unavailable", reason: "denied" },
      block: "",
      quoted: [],
      withheld: [{ id: args.event_id, reason: decision.reason }],
    };
  }
  const integrity = sha256(source.text);
  if (args.integrity !== undefined && !sameDigest(args.integrity, integrity)) {
    return { task: { status: "unavailable" }, block: "", quoted: [], withheld: [] };
  }
  const parsed = parseRecord(source.text);
  if (!parsed.ok) {
    return {
      task: {
        status: parsed.reason === "bounds" ? "incomplete" : "unavailable",
        reason: parsed.reason,
        ...(parsed.reason === "bounds" ? { integrity } : {}),
      },
      block: "",
      quoted: [],
      withheld: [],
    };
  }
  const packed = pack(args.event_id, integrity, parsed.sections, soFar, budget);
  const sections = servedSections(parsed.sections, packed.included);
  const task: TaskAttachment = {
    status: packed.status,
    ...(packed.reason === undefined ? {} : { reason: packed.reason }),
    integrity,
    ...(packed.block === "" ? {} : { sections }),
    ...(packed.omitted.length === 0 ? {} : { omitted: packed.omitted }),
  };
  if (packed.block === "") return { task, block: "", quoted: [], withheld: [] };
  return {
    task,
    block: packed.block,
    quoted: [
      {
        event_id: source.event_id,
        connector_id: source.connector_id,
        kind: source.kind,
        occurred_at: source.occurred_at,
        sensitivity: decision.sensitivity,
        subjects: source.subjects,
        text: packed.included.flatMap((kind) => sections[kind].map((value) => line(kind, value))).join("\n"),
        tainted: true,
      },
    ],
    withheld: [],
  };
}
