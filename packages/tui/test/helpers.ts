import type { StagedProposal } from "@kizuki/core/staging";
import type { Key } from "../src/keys";
import { initialState, reduce } from "../src/model";
import type { Effect, ReviewItem, ReviewState, Viewport } from "../src/model";

let counter = 0;

export function proposal(
  overrides: Partial<StagedProposal> = {},
): StagedProposal {
  counter += 1;
  const id = `01ARZ3NDEKTSV4RRFFQ69G5${String(counter).padStart(3, "0")}`;
  return {
    proposal_id: id,
    kind: "claim",
    target: null,
    body: `body of ${id}`,
    frontmatter: { type: "source", title: `Capture ${counter}` },
    provenance: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
    subjects: [],
    producer: "deterministic",
    confidence: 1,
    status: "pending",
    created_at: `2026-09-01T10:${String(counter).padStart(2, "0")}:00.000Z`,
    body_hash: "c".repeat(64),
    ...overrides,
  };
}

export function item(
  proposalOverrides: Partial<StagedProposal> = {},
  extra: Partial<Omit<ReviewItem, "proposal">> = {},
): ReviewItem {
  const p = proposal(proposalOverrides);
  const title = p.frontmatter["title"];
  return {
    proposal: p,
    title: typeof title === "string" ? title : p.body,
    subject: p.subjects[0] ?? null,
    targetPath: null,
    currentBody: null,
    currentLabel: null,
    ...extra,
  };
}

export const VIEWPORT: Viewport = { listRows: 10, detailRows: 10 };

export function state(items: ReviewItem[], batchEnabled = false): ReviewState {
  return initialState({
    vaultName: "vault",
    today: "2026-09-01",
    items,
    batchEnabled,
  });
}

export function chars(text: string): Key[] {
  return [...text].map((ch) => ({ name: "char", ch }));
}

export function named(name: Exclude<Key["name"], "char">): Key {
  return { name } as Key;
}

/** Feeds keys in order and returns the final state with every effect emitted. */
export function press(
  start: ReviewState,
  keys: Key[],
  viewport: Viewport = VIEWPORT,
): { state: ReviewState; effects: Effect[] } {
  let current = start;
  const effects: Effect[] = [];
  for (const key of keys) {
    const step = reduce(current, key, viewport);
    current = step.state;
    effects.push(...step.effects);
  }
  return { state: current, effects };
}

export function resetCounter(): void {
  counter = 0;
}
