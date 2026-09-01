export interface DiffLine {
  op: "same" | "add" | "del";
  text: string;
}

/** Above this many cell comparisons the LCS table is not worth building. */
const LCS_BUDGET = 4_000_000;

/**
 * Line diff of `before` → `after`. Small inputs get a true LCS alignment;
 * pathological ones degrade to "everything removed, everything added" so a
 * huge proposal can never stall the review screen.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length === 0 ? [] : before.split("\n");
  const b = after.length === 0 ? [] : after.split("\n");
  if (a.length * b.length > LCS_BUDGET) {
    return [
      ...a.map((text): DiffLine => ({ op: "del", text })),
      ...b.map((text): DiffLine => ({ op: "add", text })),
    ];
  }

  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const idx = i * cols + j;
      table[idx] =
        a[i] === b[j]
          ? (table[idx + cols + 1] ?? 0) + 1
          : Math.max(table[idx + cols] ?? 0, table[idx + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if (
      (table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)
    ) {
      out.push({ op: "del", text: a[i] ?? "" });
      i += 1;
    } else {
      out.push({ op: "add", text: b[j] ?? "" });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) out.push({ op: "del", text: a[i] ?? "" });
  for (; j < b.length; j += 1) out.push({ op: "add", text: b[j] ?? "" });
  return out;
}
