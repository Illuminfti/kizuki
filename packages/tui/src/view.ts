import type { ProposalKind } from "@kizuki/core";
import { COLOR, padEnd, sanitize, stringWidth, truncate, wrap } from "./ansi";
import type { Paint } from "./ansi";
import { diffLines } from "./diff";
import { KIND_LABEL, batchEligible, currentItem, cursorRow } from "./model";
import type { ReviewItem, ReviewState } from "./model";

export interface RenderOptions {
  cols: number;
  rows: number;
  paint: Paint;
}

export interface Layout {
  split: boolean;
  listWidth: number;
  detailWidth: number;
  bodyRows: number;
}

const MIN_ROWS = 8;
const MIN_COLS = 40;
const SPLIT_AT = 96;

const BADGE: Record<ProposalKind, string> = {
  purge_review: "PRG",
  deletion: "DEL",
  edit: "EDT",
  merge: "MRG",
  claim: "CAP",
  entity: "ENT",
};

const BADGE_COLOR: Record<ProposalKind, number> = {
  purge_review: COLOR.purge,
  deletion: COLOR.deletion,
  edit: COLOR.edit,
  merge: COLOR.merge,
  claim: COLOR.capture,
  entity: COLOR.entity,
};

const LABEL_COLOR = {
  public: COLOR.ok,
  personal: COLOR.warn,
  private: COLOR.danger,
} as const;

export function layout(cols: number, rows: number): Layout {
  const bodyRows = Math.max(1, rows - 4);
  if (cols < SPLIT_AT)
    return { split: false, listWidth: cols, detailWidth: cols, bodyRows };
  const listWidth = Math.min(60, Math.max(34, Math.floor(cols * 0.42)));
  return {
    split: true,
    listWidth,
    detailWidth: cols - listWidth - 1,
    bodyRows,
  };
}

function rule(width: number, p: Paint): string {
  return p.fg(COLOR.rule, "─".repeat(Math.max(0, width)));
}

function producerTag(item: ReviewItem): string {
  const producer = item.proposal.producer;
  if (producer === "deterministic")
    return `${Math.round(item.proposal.confidence * 100)}%`;
  if (producer === "llm") return "llm";
  return `ag:${producer.slice("agent:".length)}`;
}

function header(state: ReviewState, cols: number, p: Paint): string {
  const counts = state.groups.map((g) => `${g.count} ${g.label}`).join(", ");
  const pending = `${state.items.length} pending${state.filter ? ` (filter: ${sanitize(state.filter)})` : ""}`;
  const left = [
    p.fgBold(COLOR.accent, "kizuki review"),
    sanitize(state.vaultName),
    state.today,
    pending,
  ]
    .concat(counts.length > 0 ? [p.dim(counts)] : [])
    .join(p.dim(" · "));
  const session =
    state.session.promoted + state.session.rejected > 0
      ? p.dim(`session +${state.session.promoted} −${state.session.rejected}`)
      : "";
  const gap = cols - stringWidth(left) - stringWidth(session);
  if (gap >= 2) return left + " ".repeat(gap) + session;
  return truncate(
    sanitize(`kizuki review · ${state.vaultName} · ${pending}`),
    cols,
  );
}

function listLines(
  state: ReviewState,
  width: number,
  rows: number,
  p: Paint,
): string[] {
  if (state.items.length === 0) {
    const message = state.filter
      ? "no proposals match the filter"
      : "queue is empty — nothing waiting on you";
    return [p.dim(truncate(message, width))];
  }
  const all: string[] = [];
  let index = 0;
  for (const group of state.groups) {
    all.push(
      p.fg(
        COLOR.meta,
        truncate(`${group.label.toUpperCase()} · ${group.count}`, width),
      ),
    );
    for (let i = 0; i < group.count; i += 1, index += 1) {
      const item = state.items[index];
      if (item === undefined) break;
      const selected = index === state.cursor;
      const tag = producerTag(item);
      const titleWidth = Math.max(4, width - 2 - 3 - 1 - stringWidth(tag) - 1);
      const title = padEnd(truncate(item.title, titleWidth), titleWidth);
      const marker = selected ? "▸ " : "  ";
      if (selected) {
        all.push(
          p.inverse(
            padEnd(
              `${marker}${BADGE[item.proposal.kind]} ${title} ${tag}`,
              width,
            ),
          ),
        );
      } else {
        all.push(
          `${marker}${p.fg(BADGE_COLOR[item.proposal.kind], BADGE[item.proposal.kind])} ${title} ${p.dim(tag)}`,
        );
      }
    }
  }
  return all.slice(state.listScroll, state.listScroll + rows);
}

function metaLine(label: string, value: string, p: Paint): string {
  return `${p.dim(label)} ${value}`;
}

function bodyLines(item: ReviewItem, width: number, p: Paint): string[] {
  const kind = item.proposal.kind;
  const proposed = sanitize(item.proposal.body);
  if (kind === "deletion" && item.currentBody !== null) {
    return [
      p.fg(COLOR.danger, "page will be archived; current content:"),
      "",
    ].concat(wrap(sanitize(item.currentBody), width).map((l) => p.dim(l)));
  }
  if (
    (kind === "edit" || kind === "merge" || kind === "purge_review") &&
    item.currentBody !== null
  ) {
    const after =
      kind === "merge"
        ? `${sanitize(item.currentBody)}\n\n${proposed}`
        : proposed;
    const lines: string[] = [];
    for (const d of diffLines(sanitize(item.currentBody), after)) {
      const prefix = d.op === "add" ? "+" : d.op === "del" ? "-" : " ";
      for (const piece of wrap(d.text, Math.max(1, width - 2))) {
        const text = `${prefix} ${piece}`;
        lines.push(
          d.op === "add"
            ? p.fg(COLOR.ok, text)
            : d.op === "del"
              ? p.fg(COLOR.danger, text)
              : p.dim(text),
        );
      }
    }
    return lines;
  }
  return wrap(proposed, width);
}

function detailLines(state: ReviewState, width: number, p: Paint): string[] {
  const item = currentItem(state);
  if (item === null) return [p.dim("select a proposal to see it here")];
  const proposal = item.proposal;
  const created = proposal.created_at.slice(0, 16).replace("T", " ");
  const label = item.currentLabel;
  const lines: string[] = [
    p.bold(truncate(item.title, width)),
    p.dim(
      truncate(
        `${KIND_LABEL[proposal.kind]} · ${proposal.producer} · ${Math.round(proposal.confidence * 100)}% · ${created}`,
        width,
      ),
    ),
  ];
  if (item.targetPath !== null) {
    lines.push(
      metaLine("page", truncate(sanitize(item.targetPath), width - 5), p),
    );
  } else if (proposal.target !== null) {
    lines.push(
      metaLine("new page", truncate(sanitize(proposal.target), width - 9), p),
    );
  } else {
    lines.push(metaLine("new page", "captures/", p));
  }
  if (proposal.subjects.length > 0) {
    lines.push(
      metaLine(
        "subjects",
        truncate(sanitize(proposal.subjects.join(", ")), width - 9),
        p,
      ),
    );
  }
  const provenance = `${proposal.provenance.length} event${proposal.provenance.length === 1 ? "" : "s"}`;
  const labelText =
    label === null ? p.dim("none yet") : p.fg(LABEL_COLOR[label], label);
  lines.push(
    `${p.dim("provenance")} ${provenance}   ${p.dim("sensitivity")} ${labelText}`,
  );
  lines.push(rule(width, p));
  lines.push(...bodyLines(item, width, p));
  return lines;
}

const HELP = [
  "keys",
  "",
  "j / k        move           J / K   page",
  "g / G        first / last   tab     switch pane",
  "p            promote        e       edit in $EDITOR, then promote",
  "m            merge into the existing page",
  "r            reject with a reason",
  "a            batch-promote deterministic new pages (needs --batch)",
  "/            filter          ?       this help",
  "q            quit",
  "",
  "sensitivity  1 public  2 personal  3 private  enter keeps the current label",
  "",
  "Every promotion writes a receipt; nothing here is undoable by design.",
];

function footer(state: ReviewState, cols: number, p: Paint): string {
  const mode = state.mode;
  const cursor = p.dim("▏");
  if (mode.name === "filter")
    return truncate(`filter: ${sanitize(mode.text)}`, cols - 1) + cursor;
  if (mode.name === "reason")
    return truncate(`reject reason: ${sanitize(mode.text)}`, cols - 1) + cursor;
  if (mode.name === "batch-confirm") {
    return (
      truncate(
        `batch-promote ${mode.ids.length} as ${mode.sensitivity} — type yes then enter: ${sanitize(mode.text)}`,
        cols - 1,
      ) + cursor
    );
  }
  if (mode.name === "sensitivity") {
    const keep = mode.keep === null ? "" : `  enter keep ${mode.keep}`;
    const what =
      mode.action === "batch" ? `batch of ${mode.ids.length}` : mode.action;
    return truncate(
      `${what} · sensitivity  1 public  2 personal  3 private${keep}  esc cancel`,
      cols,
    );
  }
  if (mode.name === "help") return truncate("any key closes help", cols);
  const eligible = state.batchEnabled ? batchEligible(state).length : 0;
  const batch = state.batchEnabled ? `  a batch(${eligible})` : "";
  return p.dim(
    truncate(
      `j/k move  p promote  e edit  m merge  r reject${batch}  / filter  tab pane  ? help  q quit`,
      cols,
    ),
  );
}

function noticeLine(state: ReviewState, cols: number, p: Paint): string {
  if (state.notice === null) return "";
  const text = truncate(sanitize(state.notice.text), cols);
  if (state.notice.tone === "ok") return p.fg(COLOR.ok, text);
  if (state.notice.tone === "warn") return p.fg(COLOR.warn, text);
  return p.fg(COLOR.danger, text);
}

function fit(lines: string[], rows: number, width: number): string[] {
  const out = lines.slice(0, rows).map((line) => padEnd(line, width));
  while (out.length < rows) out.push(" ".repeat(width));
  return out;
}

/** Renders exactly `rows` lines, each exactly `cols` cells wide. */
export function render(state: ReviewState, opts: RenderOptions): string[] {
  const { cols, rows, paint: p } = opts;
  if (rows < MIN_ROWS || cols < MIN_COLS) {
    return fit(
      [truncate(`kizuki review needs at least ${MIN_COLS}×${MIN_ROWS}`, cols)],
      rows,
      cols,
    );
  }
  const l = layout(cols, rows);
  const listRows = state.focus === "list" || l.split ? l.bodyRows : 0;
  const detailContent =
    state.mode.name === "help"
      ? HELP.map((line) => (line === "keys" ? p.bold(line) : line))
      : detailLines(state, l.detailWidth, p).slice(state.detailScroll);

  let body: string[];
  if (l.split) {
    const left = fit(
      listLines(state, l.listWidth, listRows, p),
      l.bodyRows,
      l.listWidth,
    );
    const right = fit(detailContent, l.bodyRows, l.detailWidth);
    body = left.map(
      (line, i) => `${line}${p.fg(COLOR.rule, "│")}${right[i] ?? ""}`,
    );
  } else if (state.focus === "list" && state.mode.name !== "help") {
    body = fit(listLines(state, cols, l.bodyRows, p), l.bodyRows, cols);
  } else {
    body = fit(detailContent, l.bodyRows, cols);
  }

  const cursorHint = l.split
    ? ""
    : state.focus === "list"
      ? " list"
      : " detail";
  const lines = [
    padEnd(header(state, cols, p), cols),
    padEnd(rule(cols - stringWidth(cursorHint), p) + p.dim(cursorHint), cols),
    ...body,
    padEnd(noticeLine(state, cols, p), cols),
    padEnd(footer(state, cols, p), cols),
  ];
  return fit(lines, rows, cols);
}

/** Row budget the reducer needs to keep the cursor on screen. */
export function viewportFor(
  cols: number,
  rows: number,
): { listRows: number; detailRows: number } {
  const l = layout(cols, rows);
  return { listRows: l.bodyRows, detailRows: l.bodyRows };
}

export { cursorRow };
