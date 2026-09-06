# Approved P048 and P072 production scopes

Root authorization recorded 2026-09-06. Base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, tree `8ec4dd36ba80041c13cdf75f09fc17fa8e0e25c0`. Each worker owns only its packet's relative write paths. This handoff grants no supervisor, core, controller, provider-account or other worker scope.

## P048: Telegram cancellation and wait diagnostics

Root accepted the narrow diagnostic scope in `GROK-R053-R093-R074-REVIEW/REVIEW.md`. Correct only `packages/cli/src/commands/connect-telegram.ts` and its two assigned test files.

- Preserve the local Ctrl-C cancellation classification with fixed safe wording. The phone prompt currently reaches the final mapper as UsageError and is changed into generic ConnectionError. At code/password prompts, the provider adapter may wrap the exception; remember that a local cancellation occurred rather than assuming the final thrown object retains its type.
- Keep positive safe `retry_after` values in the existing duration-specific wait message. A classified `flood_wait` without a usable positive duration must still tell the user to wait, without inventing a number or changing cooldown/retry behavior.
- Retain sanitization for unknown errors and ordinary transport failures. Do not pass arbitrary exception text through. No new auth modes, credentials, provider error taxonomy or connector source changes.
- Add normal helper/enrollment coverage for phone, code and password cancellation; positive and unspecified waits; unchanged successful enrollment and ordinary transport failure. Preserve existing assertions and normal cleanup behavior.

## P072: frozen root warning contract

Root independently accepted P071 candidate `a90db5339762f2436bb446b805d8fc81cdeeada8`; the qualified result has 15 passing tests and 62 assertions. P072 is now unlocked for reporting only. P071's file remains separately owned and must not be copied, edited or squashed into this scope.

The following root instruction is the binding warning contract:

> Fresh pre-capture Claude health observation, emit fixed bounded line on stderr for degraded health, clearly label as health check before capture and partial/unsupported content; do not print arbitrary health.detail, file/path/message, do not call it capture-exact or alter stdout counts/exit; apply initial/repeat; existing blocked health behavior preserved.

Implement this only in `packages/cli/src/commands/import.ts`, with ordinary public-process coverage in the new `packages/cli/test/import-claude-lifecycle.test.ts`. A suitable fixed warning is `degraded: Claude health check before capture found partial or unsupported content.` The literal wording may differ only if it retains the approved meaning and remains fixed and bounded.

Use the existing Claude connector health seam before capture for both initial and repeated imports. This is a labeled health observation; do not claim it is the exact snapshot captured. Keep existing initial enrollment-blocking health behavior, source-consent behavior, tolerant partial import, invocation stdout counts and process exit semantics. Do not introduce a new diagnostic/core/connector schema or inspect/render arbitrary health detail.

Normal acceptance:

1. A clean two-message Claude export imports with existing counts and no new degraded-health warning; unchanged repeat stores zero new events.
2. An ordinary export containing supported text plus an unsupported content part retains the supported content and emits exactly the fixed bounded warning on stderr before capture. Current counts and successful partial-import exit semantics are unchanged.
3. A repeated import of that partial export emits the same labeled warning and no extra stored events.
4. Existing enrollment-blocking health refusal is preserved. No warning includes the export path, private content, arbitrary provider/health detail, or a claim about the exact captured snapshot.

## Validation and delivery

Follow the production worker's existing test-request mechanism. Request the assigned tests through root's qualified runner; do not install dependencies or launch a second runner if the worker environment forbids it. Preserve failures and report exact candidate SHA, paths, request and result receipts. Root owns final checks and independent acceptance. No product/native/account/release acceptance follows from a worker finishing.
