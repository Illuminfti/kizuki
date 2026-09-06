# P048 Telegram CLI diagnostics independent review

**Verdict: ACCEPT for the bounded correction at
`771f7c774096e86c2402f7fa54635f889d5fc3aa`.** I found no blocking source,
security, or contract issue. This accepts the candidate for integration; it is
not account, native-provider, merged-artifact, or release qualification.

## Exact scope

- Candidate tree: `33b0027d39899d764d610543709191d1092eece7`.
- Sole parent/base: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`,
  tree `8ec4dd36ba80041c13cdf75f09fc17fa8e0e25c0`.
- The worktree is clean. The complete base-to-head diff changes only the three
  paths granted by `P048-P072-WORKER-HANDOFF.md` and
  `GROK-FLEET-PRODUCTION-P048-P072-20260906.json`:
  `packages/cli/src/commands/connect-telegram.ts`,
  `packages/cli/test/telegram-enrollment.test.ts`, and the new
  `packages/cli/test/telegram-signin-diagnostics.test.ts`. It has 246 additions
  and 6 deletions; `git diff --check` passes. Full patch SHA-256:
  `b1e1708da406a25ef37cbb5624f75979bc773cc3ed4ba4e4bda7d73d4fbd4d2e`.

## Behavior and security review

The terminal prompt already emits the fixed `UsageError` text `interactive
sign-in cancelled` for Ctrl-C and a different fixed text for malformed terminal
input. The candidate checks that exact class-and-message pair at the CLI
boundary. Its prompt adapter records a monotonic, invocation-local cancellation
flag before rethrowing. The final mapper consults that flag, so a provider
adapter may replace the thrown object and the locally observed Ctrl-C still
reaches top-level CLI dispatch as the same fixed `UsageError`. Phone, code, and
password prompts all pass through this adapter.

The classification is deliberately narrow. Other `UsageError` text, arbitrary
exceptions, and ordinary provider transport failures do not set the flag and
continue through fixed `ConnectionError` messages. Provider and prompt error
text is not forwarded. The connector-owned notification vocabulary remains
allowlisted. The changed mapper does not expose phone numbers, codes,
passwords, sessions, provider details, or exception causes.

A `flood_wait` with a positive safe-integer `retry_after` retains the existing
duration-specific message. The same classified error with an absent, zero,
negative, non-integer, non-finite, or otherwise unusable duration now uses the
fixed sentence `Telegram asked you to wait before retrying.` It neither invents
a count nor tells the owner to retry immediately for connectivity. Other
provider codes retain their existing closed messages and unknown codes retain
the generic connectivity fallback.

The enrollment control flow is otherwise unchanged. Pending state is discarded
on a sign-in throw, successful state is published only after confirmed account
identity, and the candidate keeps `connector.close()` in the existing `finally`
block. Cancellation cannot reach sensitivity application, success output, or
source enrollment. Credentials, cooldown persistence and retry behavior,
identity replacement, consent, connector source, and account calls are
unchanged.

## Tests and retained identity

The added tests cover the mapper and the real enrollment seam for phone, code,
and password cancellation, including a synthetic provider wrapper that replaces
the prompt exception. They also cover positive and unspecified flood waits,
ordinary unreachable and unknown errors, no enrollment/success output on
failure, and connector disconnect. Existing successful enrollment, credential,
identity, consent, cooldown, redaction, and transport-cleanup assertions remain.
All cases use temporary vaults and scripted/pure adapters; no live provider or
account is involved.

Root's sealed run `a2c7c97257de48e493ee34bbfbb76e87` executed the two
assigned files: **18 pass, 0 fail, 114 assertions** under Bun 1.3.14. Receipt
status is `passed`, exit is 0, `stale` is false, cleanup is confirmed, and input
identity is unchanged before/after. The no-network, read-only,
capability-dropped container receipt is SHA-256
`23ecff759e53898b62c12e39e1e77764417fa256be5ff629578373e0cd1b896c`.

The candidate worktree, candidate Git blobs, sealed test-source files, and
receipt metadata independently agree on these SHA-256 values:

| Path | SHA-256 |
| --- | --- |
| `packages/cli/src/commands/connect-telegram.ts` | `cf76f43b6040211026c99a613044df16a4489a368d3d31da83b5d158de719b47` |
| `packages/cli/test/telegram-enrollment.test.ts` | `f4fd7942fa510f2dcd8b6404de83b4a681bbbecd42d49007db3e053882cdbddf` |
| `packages/cli/test/telegram-signin-diagnostics.test.ts` | `f81b6396a735a4056eefaebb9324de2b45e6e6a3752e9eb9bd0413b8d111da02` |

This review read source and retained evidence only. I did not run tests,
reproduce provider behavior, inspect an account, or edit the candidate. Full
CLI/type/repository checks and exact-head integration remain separate gates.
