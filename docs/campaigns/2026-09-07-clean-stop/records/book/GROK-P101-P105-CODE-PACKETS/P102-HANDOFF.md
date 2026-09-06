# P102 worker handoff: native artifact retention binding

Base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, tree `8ec4dd36ba80041c13cdf75f09fc17fa8e0e25c0`. Own exactly `.github/workflows/ci.yml`, `.github/workflows/macos-native.yml`, `scripts/verify-workflows.ts`, and `scripts/verify-workflows.test.ts`.

## Defect and required behavior

Each native workflow supplies the package directory and proof `receipt.json` to one upload action. `if-no-files-found: error` fails only when the complete path set matches nothing. Because upload runs with `always()`, a built package can be retained without the receipt after proof failure. The validator pins the macOS upload fields but does not independently require receipt production, and it does not pin the corresponding Linux proof/upload sequence.

Make receipt presence an explicit success precondition before retention on Linux and macOS. A proof failure or absent expected receipt must prevent a package-only retained artifact. Keep the pinned upload action and repository-only retention. Extend the validator to bind the complete Linux and macOS proof command, receipt check, success condition, artifact name, exact package and receipt paths, seven-day retention and `if-no-files-found: error`.

Add mutation tests for both workflows: missing or renamed receipt check, package-only upload path, wrong receipt path, `always()` retention, action/tag drift, name/path/retention changes and proof-command removal all fail validation. Preserve existing event-head, checkout, Bun, host, cost and diff-integrity checks.

## Validation and boundaries

Run `bun test scripts/verify-workflows.test.ts` with Bun 1.3.14 and applicable repository checks. Record final SHA/tree and exact results in `/work/out/result.json`.

Do not add download tooling, change release artifact formats, contact GitHub, edit P004/P006/P015/P057/Astra files, or claim that upload success is native or release acceptance.
