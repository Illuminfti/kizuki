# Shadow parity run

`kizuki parity run` measures how far Kizuki's recall context agrees with an existing memory stack on a fixed query set. It reports a number and leaves a receipt. It never changes what an agent sees.

## What a run does

For each query in the file it does two things in order.

1. Asks Kizuki for a recall context packet with the owner principal (the same read as `kizuki context --purpose recall`, budget 2000). The chunks in the packet are the Kizuki side, best first, cut to `--k`.
2. Runs the `--estate-cmd` argv once as a local child process. The query replaces `{query}` in any argument, or is appended last. There is no shell and no stdin. stdout is read up to 1 MiB and must hold one source key per line; stderr is discarded. The whole run is killed at `--timeout-ms`.

A source key is compared as plain text. A stack key is shared when it equals a canon page path, a source reference listed on a canon page, or a ledger event id of any returned Kizuki chunk. Overlap for a query is shared keys over the stack's keys (the stack is the baseline being matched). The run's mean is the average over queries that could be compared.

## Verdicts and exit codes

| Exit | Meaning |
| --- | --- |
| 0 | mean overlap at or above `--min-overlap` |
| 1 | Kizuki failed for at least one query (recorded), or the vault could not be opened |
| 2 | usage error, raised before any vault is opened; no query text is echoed |
| 3 | the external command failed for at least one query (recorded, the run continues) |
| 4 | mean overlap below `--min-overlap`, or no query had a comparable answer |

When several apply, a Kizuki failure (1) outranks a stack failure (3), which outranks a parity miss (4), because a failing side makes the measured overlap unreliable. A run where no query is comparable has verdict `not_measured` and exits 4. It is never scored as met.

## Receipt

`<vault>/.kizuki/receipts/parity/<run id>.json`, schema `kizuki.parity-receipt/v1`, written atomically with mode 0600 inside a 0700 directory. The control directory is not part of an export, so receipts stay on the machine.

- `config`: query count, `k`, timeout, threshold and a digest of the stack argv.
- `queries[]`: index, query digest (full SHA-256), for each side a status, error class, latency and result count, and `overlap` with shared count, ratio, and short digests (16 hex characters) of the keys only one side returned, at most `k` each.
- `summary`: compared count, mean overlap, verdict, failure counts and the exit code.

Error classes for the stack: `spawn_failed`, `timeout`, `nonzero_exit` (with the exit code), `output_too_large`. For Kizuki: `context_incomplete`, `kizuki_error`. A retrieval fallback to the lexical floor shows up as `kizuki.degraded`.

A receipt holds no query text, no result text and no source name. The vault's audit trail is a separate record: each Kizuki read is an ordinary audited owner read and is logged with its arguments, as `kizuki context` is. The digests are unsalted so a query keeps one id across runs; a short, guessable query can therefore be confirmed by a reader of the file. Receipts are not pruned by the command.

## What it never does

- It injects no context and returns no packet text.
- It writes no canon and appends no ledger event. The only vault writes are the audit rows that every owner read leaves and the receipt file. The test compares every ledger table other than the audit trail, the canon files and the canon receipt log before and after a run.
- It opens no network connection. The stack command is the owner's own local command and runs with the caller's environment.
- It installs no schedule. Running it on a timer on a machine is an owner decision.

## Where it is tested

`packages/cli/test/parity.test.ts` drives the real CLI against two fake stacks (one that mirrors Kizuki's own sources, one that is unrelated) and covers usage errors, hashed-only receipts with a sentinel-string check, unchanged state, failing, hanging, missing and flooding stacks, and the threshold exit codes.

## Known limits

- The query is an argument of the stack command, so it is visible in the local process list while that command runs.
- The stack command inherits the caller's environment. It is the owner's own command; nothing is filtered.
- Only the direct child is killed on timeout or overflow. A stack command that leaves its own children behind must reap them itself.
- The per-query timeout bounds the stack command. The in-process Kizuki read has no separate bound.
- Source keys are matched as exact text, so the stack must emit keys in Kizuki's vocabulary (page paths, page source references or ledger event ids). Mapping a stack's own identifiers to those is the job of the wrapper command, which lives outside the repository.
- Receipts accumulate one file per run.
