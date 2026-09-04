import type { AuditReceipt } from "@kizuki/core";
import type { Key } from "../src/keys";
import { initialState, reduce } from "../src/model";
import type { AuditItem, AuditState, Effect, Viewport } from "../src/model";

let counter = 0;

export function receipt(overrides: Partial<AuditReceipt> = {}): AuditReceipt {
  counter += 1;
  const id = `01ARZ3NDEKTSV4RRFFQ69G5${String(counter).padStart(3, "0")}`;
  return {
    receipt_id: id,
    kind: "write",
    claim_ids: [id],
    page_path: "people/grace.md",
    page_action: "create",
    before_hash: null,
    after_hash: "a".repeat(64),
    archive_path: null,
    writer: "loop",
    producer: "deterministic",
    model_ref: null,
    authority: "connector_evidence",
    confidence: 0.8,
    sensitivity: "personal",
    taint: "clean",
    provenance: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
    superseded: [],
    candidates: [],
    retrieval_ops: [],
    reverts: null,
    reverted_by: null,
    at: `2026-09-02T10:${String(counter).padStart(2, "0")}:00.000Z`,
    contested: false,
    ambiguous: false,
    ...overrides,
  };
}

export function item(
  receiptOverrides: Partial<AuditReceipt> = {},
  extra: Partial<Omit<AuditItem, "receipt">> = {},
): AuditItem {
  const r = receipt(receiptOverrides);
  return {
    receipt: r,
    title: extra.title ?? r.page_path,
    priorBody: extra.priorBody ?? null,
    currentBody: extra.currentBody ?? "Grace runs partnerships at Acme.\n",
    evidence: extra.evidence ?? r.provenance.map((id) => `event ${id}`),
    loadError: extra.loadError ?? null,
  };
}

export const VIEWPORT: Viewport = { listRows: 10, detailRows: 10 };

export function state(items: AuditItem[]): AuditState {
  return initialState({
    vaultName: "vault",
    today: "2026-09-02",
    items,
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
  start: AuditState,
  keys: Key[],
  viewport: Viewport = VIEWPORT,
): { state: AuditState; effects: Effect[] } {
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
