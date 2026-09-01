import type { ProposalKind } from "@kizuki/core";
import type { Sensitivity, StagedProposal } from "@kizuki/core/staging";
import type { Key } from "./keys";

/**
 * The review screen as a pure state machine: `reduce` turns one key into the
 * next state plus the effects the app must carry out (promote, reject, open
 * an editor, quit). Nothing here touches the terminal or the database, which
 * is what lets every interaction be tested without a TTY.
 */

export interface ReviewItem {
  proposal: StagedProposal;
  title: string;
  subject: string | null;
  /** Vault-relative path of the page this proposal targets, when it exists. */
  targetPath: string | null;
  currentBody: string | null;
  currentLabel: Sensitivity | null;
}

export interface Group {
  kind: ProposalKind;
  label: string;
  start: number;
  count: number;
}

export type Mode =
  | { name: "list" }
  | { name: "help" }
  | { name: "filter"; text: string }
  | { name: "reason"; id: string; text: string }
  | {
      name: "sensitivity";
      action: "promote" | "merge" | "batch";
      ids: string[];
      keep: Sensitivity | null;
      editBody: string | null;
    }
  | {
      name: "batch-confirm";
      ids: string[];
      sensitivity: Sensitivity;
      text: string;
    };

export interface Notice {
  text: string;
  tone: "ok" | "warn" | "error";
}

export interface ReviewState {
  vaultName: string;
  today: string;
  all: ReviewItem[];
  items: ReviewItem[];
  groups: Group[];
  cursor: number;
  listScroll: number;
  detailScroll: number;
  focus: "list" | "detail";
  mode: Mode;
  notice: Notice | null;
  filter: string;
  batchEnabled: boolean;
  session: { promoted: number; rejected: number };
}

export type Effect =
  | {
      type: "promote";
      id: string;
      sensitivity: Sensitivity;
      editBody: string | null;
    }
  | { type: "reject"; id: string; reason: string }
  | { type: "edit"; id: string }
  | { type: "merge"; id: string; sensitivity: Sensitivity }
  | { type: "batch"; ids: string[]; sensitivity: Sensitivity }
  | { type: "quit" };

export interface Viewport {
  listRows: number;
  detailRows: number;
}

export interface Step {
  state: ReviewState;
  effects: Effect[];
}

/** Decisions that change or remove canon come first; new pages last. */
export const KIND_ORDER: readonly ProposalKind[] = [
  "purge_review",
  "deletion",
  "edit",
  "merge",
  "claim",
  "entity",
];

export const KIND_LABEL: Record<ProposalKind, string> = {
  purge_review: "purge review",
  deletion: "deletion",
  edit: "edit",
  merge: "merge",
  claim: "capture",
  entity: "entity",
};

/** Kinds whose promotion rewrites or removes an existing page. */
export function touchesExistingPage(kind: ProposalKind): boolean {
  return (
    kind === "edit" ||
    kind === "merge" ||
    kind === "deletion" ||
    kind === "purge_review"
  );
}

const SENSITIVITY_KEYS: Record<string, Sensitivity> = {
  "1": "public",
  "2": "personal",
  "3": "private",
};

function kindRank(kind: ProposalKind): number {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

function matches(item: ReviewItem, needle: string): boolean {
  if (needle.length === 0) return true;
  const hay = [
    item.title,
    item.subject ?? "",
    item.targetPath ?? "",
    item.proposal.kind,
    item.proposal.producer,
    item.proposal.body,
  ]
    .join("\n")
    .toLocaleLowerCase();
  return hay.includes(needle.toLocaleLowerCase());
}

function arrange(
  all: ReviewItem[],
  filter: string,
): { items: ReviewItem[]; groups: Group[] } {
  const items = all
    .filter((item) => matches(item, filter))
    .sort((a, b) => {
      const byKind = kindRank(a.proposal.kind) - kindRank(b.proposal.kind);
      if (byKind !== 0) return byKind;
      const keyA = a.subject ?? a.targetPath ?? "";
      const keyB = b.subject ?? b.targetPath ?? "";
      if (keyA !== keyB) return keyA < keyB ? -1 : 1;
      if (a.proposal.created_at !== b.proposal.created_at) {
        return a.proposal.created_at < b.proposal.created_at ? -1 : 1;
      }
      return a.proposal.proposal_id < b.proposal.proposal_id ? -1 : 1;
    });
  const groups: Group[] = [];
  items.forEach((item, index) => {
    const last = groups.at(-1);
    if (last !== undefined && last.kind === item.proposal.kind) {
      last.count += 1;
      return;
    }
    groups.push({
      kind: item.proposal.kind,
      label: KIND_LABEL[item.proposal.kind],
      start: index,
      count: 1,
    });
  });
  return { items, groups };
}

export interface InitialStateInput {
  vaultName: string;
  today: string;
  items: ReviewItem[];
  batchEnabled: boolean;
}

export function initialState(input: InitialStateInput): ReviewState {
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
    mode: { name: "list" },
    notice: null,
    filter: "",
    batchEnabled: input.batchEnabled,
    session: { promoted: 0, rejected: 0 },
  };
}

export function currentItem(state: ReviewState): ReviewItem | null {
  return state.items[state.cursor] ?? null;
}

/** Row of the cursor in the rendered list, counting one header row per group. */
export function cursorRow(state: ReviewState): number {
  const headersAbove = state.groups.filter(
    (g) => g.start <= state.cursor,
  ).length;
  return state.cursor + headersAbove;
}

export function listRowCount(state: ReviewState): number {
  return state.items.length + state.groups.length;
}

function clampCursor(state: ReviewState, cursor: number): number {
  if (state.items.length === 0) return 0;
  return Math.min(Math.max(0, cursor), state.items.length - 1);
}

function scrolled(state: ReviewState, listRows: number): ReviewState {
  const rows = Math.max(1, listRows);
  const row = cursorRow(state);
  let listScroll = state.listScroll;
  if (row < listScroll) listScroll = row;
  if (row >= listScroll + rows) listScroll = row - rows + 1;
  // Keep the group header visible when the cursor sits on a group's first item.
  const group = state.groups.find((g) => g.start === state.cursor);
  if (group !== undefined && row - 1 < listScroll)
    listScroll = Math.max(0, row - 1);
  return listScroll === state.listScroll ? state : { ...state, listScroll };
}

function moveTo(
  state: ReviewState,
  cursor: number,
  viewport: Viewport,
): ReviewState {
  const next = clampCursor(state, cursor);
  if (next === state.cursor) return scrolled(state, viewport.listRows);
  return scrolled(
    { ...state, cursor: next, detailScroll: 0 },
    viewport.listRows,
  );
}

export function withNotice(
  state: ReviewState,
  notice: Notice | null,
): ReviewState {
  return { ...state, notice };
}

/** Reloads the queue after an effect ran; the cursor follows its item or stays put. */
export function applyItems(state: ReviewState, all: ReviewItem[]): ReviewState {
  const { items, groups } = arrange(all, state.filter);
  const currentId = currentItem(state)?.proposal.proposal_id;
  const sameIndex = items.findIndex(
    (i) => i.proposal.proposal_id === currentId,
  );
  const next: ReviewState = {
    ...state,
    all,
    items,
    groups,
    cursor: 0,
    detailScroll: 0,
  };
  next.cursor = clampCursor(next, sameIndex === -1 ? state.cursor : sameIndex);
  return scrolled(next, Number.MAX_SAFE_INTEGER);
}

/** After the owner edited a body in their editor, the label question follows. */
export function resumeAfterEdit(
  state: ReviewState,
  id: string,
  editBody: string,
): ReviewState {
  const item = state.items.find((i) => i.proposal.proposal_id === id);
  if (item === undefined)
    return withNotice(state, {
      text: "proposal is no longer pending",
      tone: "warn",
    });
  return {
    ...state,
    mode: {
      name: "sensitivity",
      action: "promote",
      ids: [id],
      keep: touchesExistingPage(item.proposal.kind) ? item.currentLabel : null,
      editBody,
    },
  };
}

export function batchEligible(state: ReviewState): ReviewItem[] {
  return state.items.filter(
    (item) =>
      item.proposal.producer === "deterministic" &&
      (item.proposal.kind === "entity" || item.proposal.kind === "claim") &&
      item.targetPath === null,
  );
}

function step(state: ReviewState, effects: Effect[] = []): Step {
  return { state, effects };
}

function listMode(state: ReviewState): ReviewState {
  return { ...state, mode: { name: "list" } };
}

function reduceText(
  text: string,
  key: Key,
): { text: string; submit: boolean; cancel: boolean } {
  if (key.name === "char")
    return { text: text + key.ch, submit: false, cancel: false };
  if (key.name === "backspace")
    return {
      text: [...text].slice(0, -1).join(""),
      submit: false,
      cancel: false,
    };
  if (key.name === "enter") return { text, submit: true, cancel: false };
  if (key.name === "escape" || key.name === "ctrl-c")
    return { text, submit: false, cancel: true };
  return { text, submit: false, cancel: false };
}

function reduceList(state: ReviewState, key: Key, viewport: Viewport): Step {
  const item = currentItem(state);
  const page = Math.max(1, viewport.listRows - 1);
  const ch = key.name === "char" ? key.ch : null;

  if (key.name === "ctrl-c" || ch === "q")
    return step(state, [{ type: "quit" }]);
  if (key.name === "tab")
    return step({
      ...state,
      focus: state.focus === "list" ? "detail" : "list",
    });
  if (ch === "?") return step({ ...state, mode: { name: "help" } });
  if (ch === "/")
    return step({ ...state, mode: { name: "filter", text: state.filter } });

  if (state.focus === "detail") {
    const max = Number.MAX_SAFE_INTEGER;
    if (ch === "j" || key.name === "down")
      return step({
        ...state,
        detailScroll: Math.min(max, state.detailScroll + 1),
      });
    if (ch === "k" || key.name === "up")
      return step({
        ...state,
        detailScroll: Math.max(0, state.detailScroll - 1),
      });
    if (ch === "J" || key.name === "pagedown")
      return step({
        ...state,
        detailScroll: state.detailScroll + Math.max(1, viewport.detailRows - 1),
      });
    if (ch === "K" || key.name === "pageup")
      return step({
        ...state,
        detailScroll: Math.max(
          0,
          state.detailScroll - Math.max(1, viewport.detailRows - 1),
        ),
      });
    if (ch === "g" || key.name === "home")
      return step({ ...state, detailScroll: 0 });
  }

  if (ch === "j" || key.name === "down")
    return step(moveTo(state, state.cursor + 1, viewport));
  if (ch === "k" || key.name === "up")
    return step(moveTo(state, state.cursor - 1, viewport));
  if (ch === "J" || key.name === "pagedown")
    return step(moveTo(state, state.cursor + page, viewport));
  if (ch === "K" || key.name === "pageup")
    return step(moveTo(state, state.cursor - page, viewport));
  if (ch === "g" || key.name === "home")
    return step(moveTo(state, 0, viewport));
  if (ch === "G" || key.name === "end")
    return step(moveTo(state, state.items.length - 1, viewport));

  if (ch === "p" || ch === "e" || ch === "m" || ch === "r") {
    if (item === null)
      return step(
        withNotice(state, { text: "nothing to review", tone: "warn" }),
      );
    const id = item.proposal.proposal_id;
    const keep = touchesExistingPage(item.proposal.kind)
      ? item.currentLabel
      : null;
    if (ch === "p") {
      return step({
        ...state,
        notice: null,
        mode: {
          name: "sensitivity",
          action: "promote",
          ids: [id],
          keep,
          editBody: null,
        },
      });
    }
    if (ch === "e")
      return step({ ...state, notice: null }, [{ type: "edit", id }]);
    if (ch === "m") {
      if (item.targetPath === null) {
        return step(
          withNotice(state, {
            text: "no existing page to merge into",
            tone: "warn",
          }),
        );
      }
      return step({
        ...state,
        notice: null,
        mode: {
          name: "sensitivity",
          action: "merge",
          ids: [id],
          keep: item.currentLabel,
          editBody: null,
        },
      });
    }
    return step({
      ...state,
      notice: null,
      mode: { name: "reason", id, text: "" },
    });
  }

  if (ch === "a") {
    if (!state.batchEnabled) {
      return step(
        withNotice(state, {
          text: "batch accept is off; start with kizuki review --batch",
          tone: "warn",
        }),
      );
    }
    const ids = batchEligible(state).map((i) => i.proposal.proposal_id);
    if (ids.length === 0) {
      return step(
        withNotice(state, {
          text: "no deterministic new-page proposals in view",
          tone: "warn",
        }),
      );
    }
    return step({
      ...state,
      notice: null,
      mode: {
        name: "sensitivity",
        action: "batch",
        ids,
        keep: null,
        editBody: null,
      },
    });
  }

  return step(state);
}

export function reduce(state: ReviewState, key: Key, viewport: Viewport): Step {
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
      );
    }
    return step({ ...state, mode: { name: "filter", text: r.text } });
  }

  if (mode.name === "reason") {
    const r = reduceText(mode.text, key);
    if (r.cancel) return step(listMode(state));
    if (r.submit) {
      const reason = r.text.trim();
      if (reason.length === 0) {
        return step(
          withNotice(state, {
            text: "a rejection needs a reason",
            tone: "warn",
          }),
        );
      }
      return step(listMode(state), [{ type: "reject", id: mode.id, reason }]);
    }
    return step({
      ...state,
      mode: { name: "reason", id: mode.id, text: r.text },
    });
  }

  if (mode.name === "sensitivity") {
    if (key.name === "escape" || key.name === "ctrl-c")
      return step(listMode(state));
    let chosen: Sensitivity | null = null;
    if (key.name === "char") chosen = SENSITIVITY_KEYS[key.ch] ?? null;
    if (key.name === "enter") chosen = mode.keep;
    if (chosen === null) return step(state);
    if (mode.action === "batch") {
      return step({
        ...state,
        mode: {
          name: "batch-confirm",
          ids: mode.ids,
          sensitivity: chosen,
          text: "",
        },
      });
    }
    const id = mode.ids[0];
    if (id === undefined) return step(listMode(state));
    if (mode.action === "merge")
      return step(listMode(state), [
        { type: "merge", id, sensitivity: chosen },
      ]);
    return step(listMode(state), [
      { type: "promote", id, sensitivity: chosen, editBody: mode.editBody },
    ]);
  }

  if (mode.name === "batch-confirm") {
    const r = reduceText(mode.text, key);
    if (r.cancel) return step(listMode(state));
    if (r.submit) {
      if (r.text.trim() !== "yes") {
        return step(
          withNotice(state, {
            text: "type yes and press enter to confirm the batch",
            tone: "warn",
          }),
        );
      }
      return step(listMode(state), [
        { type: "batch", ids: mode.ids, sensitivity: mode.sensitivity },
      ]);
    }
    return step({ ...state, mode: { ...mode, text: r.text } });
  }

  return reduceList(state, key, viewport);
}
