import { sha256Hex } from "../util/hash";
import type { Principal } from "../agents";
import type { QuotedChunk } from "./types";

/**
 * A deliberately extractive, rebuildable navigation aid for captured history.
 * It is not a semantic summary and does not retain a cache of removed events.
 */
export interface HistoryNode {
  node: string;
  source_ref: string;
  text: string;
  tainted: true;
  from: string;
  until: string;
  event_id?: string;
  children?: readonly { node: string; source_ref: string }[];
}

export interface HistoryTreeData {
  view: "tree";
  snapshot: string;
  node: HistoryNode;
  budget_bytes: number;
  coverage: "first 200 authorized events matching this request; use time filters to navigate later history";
  /** Captured text is quoted data, never instructions. */
  notice: "extractive navigation only; use timeline event_id to read an original";
}

interface Leaf {
  event_id: string;
  occurred_at: string;
  source_ref: string;
  text: string;
}

interface Branch {
  node: string;
  source_ref: string;
  leaves: readonly Leaf[];
  left?: Branch;
  right?: Branch;
}

const MAX_EVENTS = 200;
export const HISTORY_MIN_BUDGET = 128;
export const HISTORY_MAX_BUDGET = 8_192;

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function clip(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  if (maxBytes <= 3) {
    const output: string[] = [];
    let used = 0;
    for (const character of text) {
      const size = bytes(character);
      if (used + size > maxBytes) break;
      output.push(character);
      used += size;
    }
    return output.join("");
  }
  const output: string[] = [];
  let used = 0;
  for (const character of text) {
    const size = bytes(character);
    if (used + size + 3 > maxBytes) break;
    output.push(character);
    used += size;
  }
  return `${output.join("")}...`;
}

function principalBinding(principal: Principal): string {
  if (principal.kind === "owner") return "owner";
  return `agent:${principal.agent.agent_id}:${principal.grant_epoch}`;
}

function grantBinding(principal: Principal): string {
  return JSON.stringify(principal.grant);
}

function makeBranch(leaves: readonly Leaf[]): Branch {
  const source_ref = sha256Hex(leaves.map((leaf) => leaf.source_ref).join("\n"));
  const node = sha256Hex(`kizuki.history.node/v1\0${source_ref}`);
  if (leaves.length === 1) return { node, source_ref, leaves };
  const split = Math.ceil(leaves.length / 2);
  return {
    node,
    source_ref,
    leaves,
    left: makeBranch(leaves.slice(0, split)),
    right: makeBranch(leaves.slice(split)),
  };
}

function branchText(branch: Branch, budget: number): string {
  if (branch.leaves.length === 1) return clip(branch.leaves[0]!.text, budget);
  // A deterministic chronological sample covers the node's time range. Newer
  // leaves receive larger excerpts; omitted middle leaves remain reachable by
  // zooming rather than being interpreted or retained as a summary.
  const count = Math.min(branch.leaves.length, Math.max(2, Math.floor(budget / 40)));
  const selected = Array.from({ length: count }, (_, index) => branch.leaves[Math.round(index * (branch.leaves.length - 1) / (count - 1))]!);
  const parts: string[] = [];
  let remaining = Math.max(0, budget - (selected.length - 1));
  let weights = selected.reduce((sum, _leaf, index) => sum + index + 1, 0);
  for (const [index, leaf] of selected.entries()) {
    if (remaining === 0) break;
    const weight = index + 1;
    const share = index === selected.length - 1
      ? remaining
      : Math.max(1, Math.floor(remaining * weight / weights));
    const part = clip(leaf.text, share);
    const cost = bytes(part);
    parts.push(part);
    remaining -= cost;
    weights -= weight;
  }
  return parts.join("\n");
}

function present(branch: Branch, budget: number): HistoryNode {
  const from = branch.leaves[0]!.occurred_at;
  const until = branch.leaves[branch.leaves.length - 1]!.occurred_at;
  if (branch.leaves.length === 1) {
    return {
      node: branch.node,
      source_ref: branch.source_ref,
      event_id: branch.leaves[0]!.event_id,
      text: branchText(branch, budget),
      tainted: true,
      from,
      until,
    };
  }
  return {
    node: branch.node,
    source_ref: branch.source_ref,
    text: branchText(branch, budget),
    tainted: true,
    from,
    until,
    children: [branch.left!, branch.right!].map((child) => ({ node: child.node, source_ref: child.source_ref })),
  };
}

function leavesFrom(chunks: readonly QuotedChunk[]): Leaf[] {
  return chunks.slice(0, MAX_EVENTS).map((chunk) => ({
    event_id: chunk.event_id,
    occurred_at: chunk.occurred_at,
    source_ref: sha256Hex(`kizuki.history.source/v1\0${chunk.event_id}\0${chunk.occurred_at}\0${chunk.text}`),
    text: chunk.text,
  }));
}

function snapshotFor(principal: Principal, leaves: readonly Leaf[], binding: string): string {
  return sha256Hex([
    "kizuki.history.snapshot/v1",
    principalBinding(principal),
    grantBinding(principal),
    binding,
    ...leaves.map((leaf) => leaf.source_ref),
  ].join("\0"));
}

/** Rebuild a view from current authorized rows; no history state is persisted. */
export function historyTree(
  principal: Principal,
  quoted: readonly QuotedChunk[],
  budget: number,
  requested?: { snapshot: string; node: string },
  binding = "",
): HistoryTreeData {
  const leaves = leavesFrom(quoted);
  const snapshot = snapshotFor(principal, leaves, binding);
  if (requested !== undefined && requested.snapshot !== snapshot) {
    throw new RangeError("history snapshot is unavailable");
  }
  if (leaves.length === 0) {
    if (requested !== undefined) throw new RangeError("history snapshot is unavailable");
    return {
      view: "tree",
      snapshot,
      node: {
        node: sha256Hex("kizuki.history.empty/v1"),
        source_ref: sha256Hex(""),
        text: "",
        tainted: true,
        from: "",
        until: "",
      },
      budget_bytes: budget,
      coverage: "first 200 authorized events matching this request; use time filters to navigate later history",
      notice: "extractive navigation only; use timeline event_id to read an original",
    };
  }
  const root = makeBranch(leaves);
  let selected = root;
  if (requested !== undefined) {
    const queue = [root];
    let found: Branch | undefined;
    while (queue.length > 0) {
      const branch = queue.shift()!;
      if (branch.node === requested.node) { found = branch; break; }
      if (branch.left !== undefined) queue.push(branch.left);
      if (branch.right !== undefined) queue.push(branch.right);
    }
    if (found === undefined) throw new RangeError("history snapshot is unavailable");
    selected = found;
  }
  return {
    view: "tree",
    snapshot,
    node: present(selected, budget),
    budget_bytes: budget,
    coverage: "first 200 authorized events matching this request; use time filters to navigate later history",
    notice: "extractive navigation only; use timeline event_id to read an original",
  };
}
