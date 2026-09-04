import type { AuditReceipt } from "@kizuki/core";
import type { Key } from "./keys";

/**
 * The audit screen as a pure state machine. `reduce` turns one key into the
 * next state plus the effects the app must carry out. The only write effect
 * is `undo`; it goes through the core receipt reverser, never a canon writer.
 */

export const MAX_FILTER_NEEDLE = 80;
export const EVIDENCE_CAP = 16;

export interface AuditItem {
  receipt: AuditReceipt;
  title: string;
  priorBody: string | null;
  currentBody: string | null;
  loadError: string | null;
}

export interface Group {
  writer: string;
  label: string;
  start: number;
  count: number;
}

export type Mode =
  | { name: "list" }
  | { name: "help" }
  | { name: "filter"; text: string }
  | {
      name: "confirm";
      receiptId: string;
      afterHash: string;
      pagePath: string;
      text: string;
    };

export interface Notice {
  text: string;
  tone: "ok" | "warn" | "error";
}

export interface AuditState {
  vaultName: string;
  today: string;
  all: AuditItem[];
  items: AuditItem[];
  groups: Group[];
  cursor: number;
  listScroll: number;
  detailScroll: number;
  focus: "list" | "detail";
  showDetails: boolean;
  mode: Mode;
  notice: Notice | null;
  /** Persistent vault/load failure; not cleared by navigation. */
  health: Notice | null;
  filter: string;
  pageOffset: number;
  pageSize: number;
  pageTruncated: boolean;
  session: { undone: number };
}

export type Effect =
  | { type: "undo"; receiptId: string; afterHash: string; pagePath: string }
  | { type: "open"; path: string }
  | { type: "filter"; text: string }
  | { type: "page"; offset: number }
  | { type: "quit" };

export interface Viewport {
  listRows: number;
  detailRows: number;
}

export interface Step {
  state: AuditState;
  effects: Effect[];
}

function filterHaystack(item: AuditItem): string {
  return [
    item.title,
    item.receipt.page_path,
    item.receipt.receipt_id,
    item.receipt.writer,
    item.receipt.producer,
    item.receipt.page_action,
    item.receipt.authority,
    item.receipt.model_ref ?? "",
    item.receipt.before_hash ?? "",
    item.receipt.after_hash,
  ].join("\n");
}

function matches(item: AuditItem, needle: string): boolean {
  if (needle.length === 0) return true;
  const clipped = needle.slice(0, MAX_FILTER_NEEDLE);
  return filterHaystack(item).toLocaleLowerCase().includes(clipped.toLocaleLowerCase());
}

function arrange(all: AuditItem[], filter: string): { items: AuditItem[]; groups: Group[] } {
  const items = all
    .filter((item) => matches(item, filter))
    .sort((a, b) => {
      if (a.receipt.at !== b.receipt.at) return a.receipt.at < b.receipt.at ? 1 : -1;
      return a.receipt.receipt_id < b.receipt.receipt_id ? 1 : -1;
    });
  const groups: Group[] = [];
  items.forEach((item, index) => {
    const last = groups.at(-1);
    if (last !== undefined && last.writer === item.receipt.writer) {
      last.count += 1;
      return;
    }
    groups.push({
      writer: item.receipt.writer,
      label: item.receipt.writer,
      start: index,
      count: 1,
    });
  });
  return { items, groups };
}

export interface InitialStateInput {
  vaultName: string;
  today: string;
  items: AuditItem[];
  health?: Notice | null;
  pageOffset?: number;
  pageSize?: number;
  pageTruncated?: boolean;
}

export function initialState(input: InitialStateInput): AuditState {
  const { items, groups } = arrange(input.items, "");
  return {
    vaultName: input.vaultName,
    today: input.today,
    all: input.items,
    items,
    groups,
    cursor: 0,
    listScroll: 0,
    detailScroll: 0,
    focus: "list",
    showDetails: false,
    mode: { name: "list" },
    notice: null,
    health: input.health ?? null,
    filter: "",
    pageOffset: input.pageOffset ?? 0,
    pageSize: input.pageSize ?? input.items.length,
    pageTruncated: input.pageTruncated ?? false,
    session: { undone: 0 },
  };
}

export function currentItem(state: AuditState): AuditItem | null {
  return state.items[state.cursor] ?? null;
}

export function cursorRow(state: AuditState): number {
  const headersAbove = state.groups.filter((g) => g.start <= state.cursor).length;
  return state.cursor + headersAbove;
}

function clampCursor(state: AuditState, cursor: number): number {
  if (state.items.length === 0) return 0;
  return Math.min(Math.max(0, cursor), state.items.length - 1);
}

function scrolled(state: AuditState, listRows: number): AuditState {
  const rows = Math.max(1, listRows);
  const row = cursorRow(state);
  let listScroll = state.listScroll;
  if (row < listScroll) listScroll = row;
  if (row >= listScroll + rows) listScroll = row - rows + 1;
  const group = state.groups.find((g) => g.start === state.cursor);
  if (group !== undefined && row - 1 < listScroll) listScroll = Math.max(0, row - 1);
  return listScroll === state.listScroll ? state : { ...state, listScroll };
}

function moveTo(state: AuditState, cursor: number, viewport: Viewport): AuditState {
  const next = clampCursor(state, cursor);
  if (next === state.cursor) return scrolled(state, viewport.listRows);
  return scrolled({ ...state, cursor: next, detailScroll: 0 }, viewport.listRows);
}

export function withNotice(state: AuditState, notice: Notice | null): AuditState {
  return { ...state, notice };
}

export function applyItems(
  state: AuditState,
  all: AuditItem[],
  page: { offset: number; truncated: boolean; health?: Notice | null } | undefined = undefined,
): AuditState {
  const { items, groups } = arrange(all, state.filter);
  const currentId = currentItem(state)?.receipt.receipt_id;
  const sameIndex = items.findIndex((i) => i.receipt.receipt_id === currentId);
  const next: AuditState = {
    ...state,
    all,
    items,
    groups,
    cursor: 0,
    detailScroll: 0,
    pageOffset: page?.offset ?? state.pageOffset,
    pageTruncated: page?.truncated ?? state.pageTruncated,
    health: page?.health === undefined ? state.health : page.health,
  };
  next.cursor = clampCursor(next, sameIndex === -1 ? state.cursor : sameIndex);
  const mode = state.mode;
  if (mode.name === "confirm") {
    const bound = items.find((item) => item.receipt.receipt_id === mode.receiptId);
    if (
      bound === undefined ||
      bound.receipt.after_hash !== mode.afterHash ||
      bound.receipt.page_path !== mode.pagePath
    ) {
      next.mode = { name: "list" };
      next.notice = { text: "selection changed; undo confirmation cancelled", tone: "warn" };
    }
  }
  return scrolled(next, Number.MAX_SAFE_INTEGER);
}

function step(state: AuditState, effects: Effect[] = []): Step {
  return { state, effects };
}

function listMode(state: AuditState): AuditState {
  return { ...state, mode: { name: "list" } };
}

function reduceText(
  text: string,
  key: Key,
): { text: string; submit: boolean; cancel: boolean } {
  if (key.name === "char") {
    const next = text + key.ch;
    return {
      text: next.length > MAX_FILTER_NEEDLE ? next.slice(0, MAX_FILTER_NEEDLE) : next,
      submit: false,
      cancel: false,
    };
  }
  if (key.name === "backspace") {
    return { text: [...text].slice(0, -1).join(""), submit: false, cancel: false };
  }
  if (key.name === "enter") return { text, submit: true, cancel: false };
  if (key.name === "escape" || key.name === "ctrl-c") {
    return { text, submit: false, cancel: true };
  }
  return { text, submit: false, cancel: false };
}

function reduceList(state: AuditState, key: Key, viewport: Viewport): Step {
  const item = currentItem(state);
  const page = Math.max(1, viewport.listRows - 1);
  const ch = key.name === "char" ? key.ch : null;

  if (key.name === "ctrl-c" || ch === "q") return step(state, [{ type: "quit" }]);
  if (key.name === "tab") {
    return step({ ...state, focus: state.focus === "list" ? "detail" : "list" });
  }
  if (ch === "d") {
    return step({ ...state, showDetails: !state.showDetails, detailScroll: 0 });
  }
  if (ch === "?") return step({ ...state, mode: { name: "help" } });
  if (ch === "/") return step({ ...state, mode: { name: "filter", text: state.filter } });

  if (ch === "]") {
    if (!state.pageTruncated) {
      return step(withNotice(state, { text: "no later page", tone: "warn" }));
    }
    return step({ ...state, notice: null }, [
      { type: "page", offset: state.pageOffset + state.pageSize },
    ]);
  }
  if (ch === "[") {
    if (state.pageOffset <= 0) {
      return step(withNotice(state, { text: "already on first page", tone: "warn" }));
    }
    return step({ ...state, notice: null }, [
      { type: "page", offset: Math.max(0, state.pageOffset - state.pageSize) },
    ]);
  }

  if (state.focus === "detail") {
    const max = Number.MAX_SAFE_INTEGER;
    if (ch === "j" || key.name === "down") {
      return step({ ...state, detailScroll: Math.min(max, state.detailScroll + 1) });
    }
    if (ch === "k" || key.name === "up") {
      return step({ ...state, detailScroll: Math.max(0, state.detailScroll - 1) });
    }
    if (ch === "J" || key.name === "pagedown") {
      return step({
        ...state,
        detailScroll: state.detailScroll + Math.max(1, viewport.detailRows - 1),
      });
    }
    if (ch === "K" || key.name === "pageup") {
      return step({
        ...state,
        detailScroll: Math.max(0, state.detailScroll - Math.max(1, viewport.detailRows - 1)),
      });
    }
    if (ch === "g" || key.name === "home") return step({ ...state, detailScroll: 0 });
  }

  if (ch === "j" || key.name === "down") return step(moveTo(state, state.cursor + 1, viewport));
  if (ch === "k" || key.name === "up") return step(moveTo(state, state.cursor - 1, viewport));
  if (ch === "J" || key.name === "pagedown") {
    return step(moveTo(state, state.cursor + page, viewport));
  }
  if (ch === "K" || key.name === "pageup") {
    return step(moveTo(state, state.cursor - page, viewport));
  }
  if (ch === "g" || key.name === "home") return step(moveTo(state, 0, viewport));
  if (ch === "G" || key.name === "end") {
    return step(moveTo(state, state.items.length - 1, viewport));
  }

  if (ch === "o" || key.name === "enter") {
    if (item === null) {
      return step(withNotice(state, { text: "nothing to open", tone: "warn" }));
    }
    return step({ ...state, notice: null }, [{ type: "open", path: item.receipt.page_path }]);
  }

  if (ch === "u") {
    if (item === null) {
      return step(withNotice(state, { text: "nothing to undo", tone: "warn" }));
    }
    if (item.receipt.reverted_by !== null) {
      return step(
        withNotice(state, {
          text: `already reverted by ${item.receipt.reverted_by}`,
          tone: "warn",
        }),
      );
    }
    if (item.loadError !== null) {
      return step(
        withNotice(state, {
          text: `cannot undo: ${item.loadError}`,
          tone: "error",
        }),
      );
    }
    return step({
      ...state,
      notice: null,
      mode: {
        name: "confirm",
        receiptId: item.receipt.receipt_id,
        afterHash: item.receipt.after_hash,
        pagePath: item.receipt.page_path,
        text: "",
      },
    });
  }

  return step(state);
}

export function reduce(state: AuditState, key: Key, viewport: Viewport): Step {
  const mode = state.mode;

  if (mode.name === "help") return step(listMode(state));

  if (mode.name === "filter") {
    const r = reduceText(mode.text, key);
    if (r.cancel) {
      const { items, groups } = arrange(state.all, "");
      return step(
        scrolled(
          {
            ...listMode(state),
            filter: "",
            items,
            groups,
            cursor: 0,
            detailScroll: 0,
          },
          viewport.listRows,
        ),
        [{ type: "filter", text: "" }],
      );
    }
    if (r.submit) {
      const { items, groups } = arrange(state.all, r.text);
      return step(
        scrolled(
          {
            ...listMode(state),
            filter: r.text,
            items,
            groups,
            cursor: 0,
            detailScroll: 0,
            listScroll: 0,
          },
          viewport.listRows,
        ),
        [{ type: "filter", text: r.text }],
      );
    }
    return step({ ...state, mode: { name: "filter", text: r.text } });
  }

  if (mode.name === "confirm") {
    const r = reduceText(mode.text, key);
    if (r.cancel) return step(listMode(state));
    if (r.submit) {
      if (r.text.trim() !== "yes") {
        return step(
          withNotice(listMode(state), {
            text: "type yes and press enter to undo",
            tone: "warn",
          }),
        );
      }
      return step(listMode(state), [
        {
          type: "undo",
          receiptId: mode.receiptId,
          afterHash: mode.afterHash,
          pagePath: mode.pagePath,
        },
      ]);
    }
    return step({ ...state, mode: { ...mode, text: r.text } });
  }

  return reduceList(state, key, viewport);
}
