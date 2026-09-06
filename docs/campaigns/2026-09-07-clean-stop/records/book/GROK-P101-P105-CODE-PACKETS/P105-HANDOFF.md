# P105 worker handoff: explicit bounded audit pagination

Base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, tree `8ec4dd36ba80041c13cdf75f09fc17fa8e0e25c0`. Own exactly `packages/cli/src/commands/audit.ts` and `packages/cli/test/audit-undo.test.ts`.

## Defect and required behavior

Noninteractive `kizuki audit` hard-codes a 5,000-row request and emits only the returned receipts. The core audit and receipt readers already accept an offset. A larger matching history is silently presented as complete.

Expose bounded `--limit` and `--offset` on this command. Keep the maximum page size at 5,000 or lower. Request one extra row through the existing core seam, return at most the requested size, and derive `truncated` from the extra row. Preserve newest-first ordering and all since/page/writer/contested/ambiguous/reverted filters.

The JSON envelope must keep `data.receipts` and add `data.truncated` plus `data.next_offset`; use null when complete. Table output adds a clear continuation notice only when another page exists. Reject missing, non-integer, negative/zero where invalid, and over-bound arguments through the existing usage-error path. Do not edit global help or docs.

Use a small ordinary receipt fixture and a low public `--limit` to prove first, middle and final pages, exact next offsets, no duplicates/omissions, stable filtered order, table notice and invalid bounds. Do not seed 5,001 rows or perform a resource-pressure test.

## Validation and boundaries

Run `bun test packages/cli/test/audit-undo.test.ts` with Bun 1.3.14 and applicable CLI checks. Record final SHA/tree and exact results in `/work/out/result.json`.

Do not edit core pagination, output helpers, args parser, TUI, P004/P006/P015/P057/Astra files, docs/help, controller or release state. This task changes only audit's bounded public command seam.
