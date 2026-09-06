# P106: uninstall an enabled, inactive systemd service

Proposed bounded implementation packet. Base: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`. This document authorizes no worker launch, product execution, service operation, merge, or publication. Root assigns the implementation owner and admits the exact packet separately.

Write only these existing files:

- `packages/core/src/serve/supervisor.ts`
- `packages/core/test/serve/supervisor.test.ts`
- `packages/cli/test/serve/install.test.ts`

The ownership receipt is `GROK-SUPERVISOR-OWNERSHIP-20260906.json`. Prior service-lifecycle PR #448 is merged; current open PRs, held #519/#530/#500, code-worker path grants, and inspected worktrees do not reserve these three files. The app/browser owner, P015, P091/P092 native qualification, and all held branches retain their existing scope. Recheck the receipt's scope at admission if any owner or packet changes.

## Problem and required result

At f57, the real systemd query reads enablement and activity independently. A successfully queried enabled but inactive unit becomes `{state: "disabled", enabled: true}` (`supervisor.ts:85–105`). Neither `confirmedActive` nor the stricter `confirmedStopped` accepts that combination (`:204–206`), so transaction admission refuses ordinary uninstall/reinstall (`:247`) before disable runs (`:299`).

Support this known systemd state while preserving the distinction between inactive runtime and disabled enablement. Uninstall must stop/disable and verify both facts before deleting the owned unit, then reload and verify stopped state before recording `opted-out`. A successful explicit install still activates the current definition as D15/RFC 0002 requires. Recovery of a failed operation must restore the original inactive-but-enabled state without activating it.

Systemd documents that enablement alone does not start a unit, while `--now` requests the associated runtime transition. This supports a separate enablement-only restoration operation; it does not establish native Kizuki qualification. [Official systemctl documentation](https://raw.githubusercontent.com/systemd/systemd/main/man/systemctl.xml) (checked 2026-09-06; enable/disable and `--now` sections).

## Bounded design

1. Keep `confirmedStopped` unchanged: it requires `enabled === false` and an existing accepted inactive/absent/masked state. Add an internal predicate only for the known **systemd** inactive+enabled combination. Do not broaden unknown, deactivating, active-without-enabled, or launchd admission. Preserve the public `SupervisorStatus` type and its existing reporting; no status remapping or doctor change is authorized.

2. Preserve the existing required `SupervisorHost.enable()` activation semantics. Add one optional, clearly named enablement-only capability in `supervisor.ts`, such as `enableWithoutStart(unitName)`. The real systemd adapter implements it by enabling the restored unit without a start/restart/`--now` operation. Existing hosts remain structurally compatible. A host lacking the capability must refuse the newly admitted inactive+enabled transition before publishing its journal or changing the unit; it must not fall back to `enable()`. Existing active and disabled flows continue unchanged. Recovery of an inactive+enabled pending entry with an incapable host remains pending without guessing.

3. Write service-change journal version 3 with the same existing identity/location/definition/intent/enablement fields plus `previous_active: boolean`. Validate the exact version-specific key set and field types. New snapshot capture derives enablement directly from the successful query and activity from the accepted active predicate. Preserve the owned definition requirement whenever prior enablement/activity needs it. Only the three existing admitted states are supported: active+enabled, known inactive+disabled, and the newly admitted systemd inactive+enabled. No database migration is involved.

4. Continue reading exact version-2 journals with their existing six fields. Interpret a valid v2 entry's prior activity as its `previous_enabled` value: the v2 producer admitted only confirmed active+enabled or confirmed stopped+disabled states. Do not infer v2 activity from the current post-failure query, rewrite a pending v2 entry from current state, accept unsupported shapes, or silently discard it. Preserve the existing identity hash, vault/location checks, advisory lock, owned file operations, and safe error behavior.

5. Recovery first obtains the existing strict stopped/disabled observation before replacing definitions. It restores the old definition and reloads it. For a previously active entry, retain the existing activation-and-confirmation behavior. For a previously inactive+enabled entry, restore enablement with the enablement-only capability, then positively verify the expected inactive+enabled observation. For a previously disabled entry, retain the strict stopped confirmation. Write the previous intent and remove the journal only after the relevant restored observation succeeds. A failed disable, reload, enablement restoration, or observation must retain truthful pending recovery; it must not claim success or activate an originally inactive service during rollback.

6. Keep the change in the existing transaction/recovery path. Do not introduce another service manager, recovery file, SQL schema, broad lifecycle abstraction, raw diagnostic channel, or alternative app installer. Do not change launchd behavior or add native execution. A different design that needs additional write paths or public contracts must return to root as a dependency rather than expanding this packet.

## Source and test custody

The core fixture already holds activity and enablement in separate variables, but its setter couples them. Extend the fixture in the owned core test file to express legitimate independent observations and record activation versus enablement-only calls without changing old assertions.

The shared read-only CLI fixture `packages/cli/test/serve/supervisor-fixture.ts` already stores `enabled` separately from `active` in its synthetic state file. Tests in the owned install test may use that existing fixture to represent enabled+inactive. Keep richer command history or failure sequencing local to the owned test file if needed; do not edit the shared fixture or the real host's PATH/environment. All subprocesses must resolve the temporary synthetic service command, with assertions proving that setup, and must never call the real supervisor or a daemon.

All proposed tests below are ordinary synthetic lifecycle and compatibility checks. Do not construct vulnerability, predecessor-bypass, timing, resource-exhaustion, real-account, or live-service reproductions. No test has been executed by the packet author.

## Acceptance evidence

- **Ordinary uninstall:** start with an installed owned unit, then a legitimate inactive+enabled observation. Uninstall disables before removal, reloads, ends stopped+disabled/absent, records `opted-out`, removes its journal, and preserves ordinary vault content byte-for-byte. Its call trace contains no activation/restart during uninstall or recovery.
- **Ordinary rollback:** exercise a normal unsuccessful disable, failed removal reload, and failed enablement restoration. Successful recovery restores original unit bytes, previous intent, and inactive+enabled observation; no rollback activation call occurs. Unverified restoration retains the journal and the existing honest pending-recovery error. A later invocation with ordinary success responses converges.
- **Explicit reinstall:** the newly supported inactive+enabled pre-state can be reinstalled under the existing activate-current-definition contract. If the requested activation fails, rollback restores original inactivity and enablement rather than starting the old definition.
- **Journal compatibility:** explicit valid v2 active and disabled snapshots still recover according to v2's original meaning. A normal interrupted v3 inactive+enabled transaction preserves that prior state across a later invocation. Preserve all existing identity, unknown-state, lock, path, and failure assertions.
- **Existing hosts/platforms:** hosts without the optional capability still pass current active/disabled lifecycle coverage and refuse only the unsupported new transition before mutation. Existing launchd semantics and the required `enable()` behavior remain unchanged.
- **CLI composition:** public `serve --uninstall` and reinstall tests use a temporary synthetic command and assert exit status, promised JSON/output, owned unit and journal changes, preserved vault bytes, and the independent activity/enablement result. An ordinary failed recovery returns nonzero and no success payload.

Root's qualified runner owns execution of the two allowed test files on the exact submitted head. Bun is pinned to 1.3.14 at f57. Focused tests, typecheck, required repository verification, independent correctness/security review, and the standing Elegance review remain separate required evidence. Existing native Linux/macOS qualification under P091/P092/#539 remains unrun by this packet; green synthetic tests do not satisfy it.

Standing review bar from the repository skill: “Review this branch like your life depends on it. Make it as elegant, simple, and correct as possible. No weird wiring. No needless abstractions. Pure elegance.”
