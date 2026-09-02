/**
 * Unified diff of `before` → `after`. Small inputs get an LCS alignment;
 * large ones degrade to a delete-all / add-all hunk so a huge page cannot
 * stall a correction answer.
 */
const LCS_BUDGET = 4_000_000;

export function unifiedDiff(before: string, after: string, path: string): string {
  const a = before.length === 0 ? [] : before.split("\n");
  const b = after.length === 0 ? [] : after.split("\n");
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];

  if (a.length * b.length > LCS_BUDGET) {
    lines.push(`@@ -1,${a.length} +1,${b.length} @@`);
    for (const row of a) lines.push(`-${row}`);
    for (const row of b) lines.push(`+${row}`);
    return `${lines.join("\n")}\n`;
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

  type Op = { kind: "same" | "del" | "add"; text: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      ops.push({ kind: "del", text: a[i] ?? "" });
      i += 1;
    } else {
      ops.push({ kind: "add", text: b[j] ?? "" });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) ops.push({ kind: "del", text: a[i] ?? "" });
  for (; j < b.length; j += 1) ops.push({ kind: "add", text: b[j] ?? "" });

  let oldLine = 1;
  let newLine = 1;
  let idx = 0;
  while (idx < ops.length) {
    while (idx < ops.length && ops[idx]?.kind === "same") {
      oldLine += 1;
      newLine += 1;
      idx += 1;
    }
    if (idx >= ops.length) break;
    const hunkStart = idx;
    const hunkOld = oldLine;
    const hunkNew = newLine;
    let oldCount = 0;
    let newCount = 0;
    while (idx < ops.length && ops[idx]?.kind !== "same") {
      const op = ops[idx];
      if (op === undefined) break;
      if (op.kind === "del") {
        oldCount += 1;
        oldLine += 1;
      } else {
        newCount += 1;
        newLine += 1;
      }
      idx += 1;
    }
    lines.push(`@@ -${hunkOld},${oldCount} +${hunkNew},${newCount} @@`);
    for (let cursor = hunkStart; cursor < idx; cursor += 1) {
      const op = ops[cursor];
      if (op === undefined) continue;
      lines.push(`${op.kind === "del" ? "-" : "+"}${op.text}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
