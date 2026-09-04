import { COLOR, padEnd, sanitize, stringWidth, truncate, wrap } from "./ansi";
import type { Paint } from "./ansi";
import { boundedDiff } from "./diff";
import { EVIDENCE_CAP, currentItem } from "./model";
import type { AuditItem, AuditState } from "./model";

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

const ACTION_BADGE = {
  create: "NEW",
  edit: "EDT",
  archive: "ARC",
} as const;

export function layout(cols: number, rows: number): Layout {
  const bodyRows = Math.max(1, rows - 4);
  if (cols < SPLIT_AT) {
    return { split: false, listWidth: cols, detailWidth: cols, bodyRows };
  }
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

function shortHash(hash: string | null): string {
  if (hash === null) return "—";
  return hash.slice(0, 8);
}

function listedLabel(state: AuditState): string {
  const more = state.pageTruncated ? "+" : "";
  const filtered = state.filter ? ` (filter: ${sanitize(state.filter)})` : "";
  const count = state.items.length;
  if (state.filter.length > 0) {
    const noun = count === 1 ? "write" : "writes";
    return `${count} ${noun}${filtered}${more}`;
  }
  if (count === 0) return "0 writes";
  const start = state.pageOffset + 1;
  const end = state.pageOffset + count;
  const noun = count === 1 && !state.pageTruncated ? "write" : "writes";
  return `${start}–${end}${more} ${noun}`;
}

function header(state: AuditState, cols: number, p: Paint): string {
  const counts = state.groups.map((g) => `${g.count} ${g.label}`).join(", ");
  const listed = listedLabel(state);
  const left = [p.fgBold(COLOR.accent, "kizuki audit"), sanitize(state.vaultName), state.today, listed]
    .concat(counts.length > 0 ? [p.dim(counts)] : [])
    .join(p.dim(" · "));
  const session = state.session.undone > 0 ? p.dim(`session undo ${state.session.undone}`) : "";
  const gap = cols - stringWidth(left) - stringWidth(session);
  if (gap >= 2) return left + " ".repeat(gap) + session;
  return truncate(sanitize(`kizuki audit · ${state.vaultName} · ${listed}`), cols);
}

function listLines(state: AuditState, width: number, rows: number, p: Paint): string[] {
  if (state.items.length === 0) {
    const message = state.filter ? "no receipts match the filter" : "no writes yet";
    return [p.dim(truncate(message, width))];
  }
  const all: string[] = [];
  let index = 0;
  for (const group of state.groups) {
    all.push(p.fg(COLOR.meta, truncate(`${group.label.toUpperCase()} · ${group.count}`, width)));
    for (let i = 0; i < group.count; i += 1, index += 1) {
      const item = state.items[index];
      if (item === undefined) break;
      const selected = index === state.cursor;
      const badge = ACTION_BADGE[item.receipt.page_action];
      const flags = [
        item.loadError !== null ? "err" : "",
        item.receipt.reverted_by !== null ? "rev" : "",
        item.receipt.ambiguous ? "amb" : "",
        item.receipt.contested ? "con" : "",
      ]
        .filter((flag) => flag.length > 0)
        .join(" ");
      const tag = flags.length > 0 ? flags : shortHash(item.receipt.after_hash);
      const titleWidth = Math.max(4, width - 2 - 3 - 1 - stringWidth(tag) - 1);
      const title = padEnd(truncate(sanitize(item.title), titleWidth), titleWidth);
      const marker = selected ? "▸ " : "  ";
      const line = `${marker}${badge} ${title} ${tag}`;
      all.push(selected ? p.inverse(padEnd(line, width)) : `${marker}${p.fg(COLOR.edit, badge)} ${title} ${p.dim(tag)}`);
    }
  }
  return all.slice(state.listScroll, state.listScroll + rows);
}

function metaLine(label: string, value: string, p: Paint): string {
  return `${p.dim(label)} ${value}`;
}

function bodyLines(item: AuditItem, width: number, p: Paint): string[] {
  const before = item.priorBody === null ? "" : sanitize(item.priorBody);
  const after = item.currentBody === null ? "" : sanitize(item.currentBody);
  if (before.length === 0 && after.length === 0) {
    return [p.dim("no page bytes on disk for this receipt")];
  }
  const diff = boundedDiff(before, after);
  const lines: string[] = [];
  for (const d of diff.lines) {
    const prefix = d.op === "add" ? "+" : d.op === "del" ? "-" : " ";
    for (const piece of wrap(d.text, Math.max(1, width - 2))) {
      const text = `${prefix} ${piece}`;
      lines.push(
        d.op === "add" ? p.fg(COLOR.ok, text) : d.op === "del" ? p.fg(COLOR.danger, text) : p.dim(text),
      );
    }
  }
  if (diff.truncated) {
    lines.push(
      p.dim(
        truncate(
          `diff truncated · ${shortHash(item.receipt.before_hash)} → ${shortHash(item.receipt.after_hash)} · o opens the page`,
          width,
        ),
      ),
    );
  }
  return lines;
}

function idLines(label: string, ids: readonly string[], width: number, p: Paint): string[] {
  if (ids.length === 0) return [];
  const shown = ids.slice(0, EVIDENCE_CAP);
  const extra = ids.length - shown.length;
  const lines = [metaLine(label, extra > 0 ? `${shown.length} of ${ids.length}` : `${ids.length}`, p)];
  for (const id of shown) {
    lines.push(p.dim(truncate(sanitize(id), width)));
  }
  if (extra > 0) lines.push(p.dim(truncate(`… ${extra} more`, width)));
  return lines;
}

function detailLines(state: AuditState, width: number, p: Paint): string[] {
  const item = currentItem(state);
  if (item === null) return [p.dim("select a write to see it here")];
  const receipt = item.receipt;
  const created = receipt.at.slice(0, 16).replace("T", " ");
  const lines: string[] = [
    p.bold(truncate(sanitize(item.title), width)),
    p.dim(
      truncate(
        `${receipt.page_action} · ${receipt.writer} · ${receipt.producer} · ${created}`,
        width,
      ),
    ),
    metaLine("receipt", truncate(sanitize(receipt.receipt_id), width - 8), p),
    metaLine("page", truncate(sanitize(receipt.page_path), width - 5), p),
    ...wrap(`before ${receipt.before_hash ?? "—"}`, width).map((line) => p.dim(line)),
    ...wrap(`after  ${receipt.after_hash}`, width).map((line) => p.dim(line)),
    metaLine("authority", truncate(sanitize(receipt.authority), width - 10), p),
    metaLine(
      "model",
      truncate(sanitize(receipt.model_ref ?? "none"), width - 6),
      p,
    ),
  ];
  if (item.loadError !== null) {
    lines.push(p.fg(COLOR.danger, truncate(`load error: ${sanitize(item.loadError)}`, width)));
  }
  if (receipt.reverted_by !== null) {
    lines.push(metaLine("reverted", truncate(sanitize(receipt.reverted_by), width - 9), p));
  }
  if (receipt.reverts !== null) {
    lines.push(metaLine("reverts", truncate(sanitize(receipt.reverts), width - 8), p));
  }
  const flags = [
    `confidence ${receipt.confidence}`,
    receipt.sensitivity,
    receipt.taint,
    receipt.ambiguous ? "ambiguous" : "",
    receipt.contested ? "contested" : "",
  ]
    .filter((flag) => flag.length > 0)
    .join(" · ");
  lines.push(p.dim(truncate(flags, width)));
  lines.push(...idLines("events", receipt.provenance, width, p));
  lines.push(...idLines("claims", receipt.claim_ids, width, p));
  if (receipt.superseded.length > 0) {
    lines.push(
      ...idLines(
        "superseded",
        receipt.superseded.map((row) => row.claim_id),
        width,
        p,
      ),
    );
  }
  lines.push(rule(width, p));
  lines.push(...bodyLines(item, width, p));
  return lines;
}

const HELP = [
  "keys",
  "",
  "j / k        move           J / K   page",
  "g / G        first / last   tab     switch pane",
  "[ / ]        older / newer receipt page",
  "u            undo the selected write (type yes)",
  "o / enter    open the page",
  "/            filter          ?       this help",
  "q            quit",
  "",
  "Every write is receipted and undoable. Undo restores the prior bytes",
  "from the archive for the exact receipt and after-hash on screen.",
];

function footer(state: AuditState, cols: number, p: Paint): string {
  const mode = state.mode;
  const cursor = p.dim("▏");
  if (mode.name === "filter") {
    return truncate(`filter: ${sanitize(mode.text)}`, cols - 1) + cursor;
  }
  if (mode.name === "confirm") {
    return (
      truncate(
        `undo ${mode.receiptId} ${shortHash(mode.afterHash)} — type yes then enter: ${sanitize(mode.text)}`,
        cols - 1,
      ) + cursor
    );
  }
  if (mode.name === "help") return truncate("any key closes help", cols);
  return p.dim(
    truncate("j/k move  u undo  o open  [ ] page  / filter  tab pane  ? help  q quit", cols),
  );
}

function noticeLine(state: AuditState, cols: number, p: Paint): string {
  const notice = state.notice ?? state.health;
  if (notice === null) return "";
  const text = truncate(sanitize(notice.text), cols);
  if (notice.tone === "ok") return p.fg(COLOR.ok, text);
  if (notice.tone === "warn") return p.fg(COLOR.warn, text);
  return p.fg(COLOR.danger, text);
}

function fit(lines: string[], rows: number, width: number): string[] {
  const out = lines.slice(0, rows).map((line) => padEnd(line, width));
  while (out.length < rows) out.push(" ".repeat(width));
  return out;
}

/** Renders exactly `rows` lines, each exactly `cols` cells wide. */
export function render(state: AuditState, opts: RenderOptions): string[] {
  const { cols, rows, paint: p } = opts;
  if (rows < MIN_ROWS || cols < MIN_COLS) {
    return fit([truncate(`kizuki audit needs at least ${MIN_COLS}×${MIN_ROWS}`, cols)], rows, cols);
  }
  const l = layout(cols, rows);
  const listRows = state.focus === "list" || l.split ? l.bodyRows : 0;
  const detailContent =
    state.mode.name === "help"
      ? HELP.map((line) => (line === "keys" ? p.bold(line) : line))
      : detailLines(state, l.detailWidth, p).slice(state.detailScroll);

  let body: string[];
  if (l.split) {
    const left = fit(listLines(state, l.listWidth, listRows, p), l.bodyRows, l.listWidth);
    const right = fit(detailContent, l.bodyRows, l.detailWidth);
    body = left.map((line, i) => `${line}${p.fg(COLOR.rule, "│")}${right[i] ?? ""}`);
  } else if (state.focus === "list" && state.mode.name !== "help") {
    body = fit(listLines(state, cols, l.bodyRows, p), l.bodyRows, cols);
  } else {
    body = fit(detailContent, l.bodyRows, cols);
  }

  const cursorHint = l.split ? "" : state.focus === "list" ? " list" : " detail";
  const lines = [
    padEnd(header(state, cols, p), cols),
    padEnd(rule(cols - stringWidth(cursorHint), p) + p.dim(cursorHint), cols),
    ...body,
    padEnd(noticeLine(state, cols, p), cols),
    padEnd(footer(state, cols, p), cols),
  ];
  return fit(lines, rows, cols);
}

export function viewportFor(
  cols: number,
  rows: number,
): { listRows: number; detailRows: number } {
  const l = layout(cols, rows);
  return { listRows: l.bodyRows, detailRows: l.bodyRows };
}
